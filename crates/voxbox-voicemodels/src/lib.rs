//! voice-models.com client (no official API: the listing endpoint returns HTML rows).
//!
//! [`Client::search`] lists one page (25 models) of the catalogue, filtered by a query;
//! [`Client::download`] streams a model zip to disk and [`extract_model`] picks its checkpoint.
//! All listing extraction is isolated in [`parser`].

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use reqwest::blocking::{Client as HttpClient, Response};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use url::Url;
use voxbox_net::same_origin;

pub mod extract;
pub mod parser;

pub use extract::extract_model;
pub use parser::{parse_page, parse_response};

const USER_AGENT: &str = "VoxBox/0.1";
/// Per read of a listing, and for the whole listing request (see `Client::search`).
const LISTING_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Blocking reqwest applies this to each read of the body: a stalled download fails, a slow one does not.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 10;
/// A listing page weighs about 120 KB: anything far larger is refused before parsing.
const MAX_LISTING_BYTES: u64 = 4_000_000;
/// Whole-download budget: 1 GB at about 0.5 MB/s. A stalled read fails sooner (see above).
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(30 * 60);
/// Largest model archive accepted.
pub const MAX_DOWNLOAD_BYTES: u64 = 1_000_000_000;

#[derive(Debug, thiserror::Error)]
pub enum VoiceModelsError {
    #[error("voice-models.com est injoignable : {0}")]
    Network(String),
    #[error("Téléchargement du modèle interrompu : {0}")]
    Download(String),
    #[error("la réponse de voice-models.com a changé de format : {0}")]
    Parse(String),
    #[error("Le serveur a répondu avec le statut HTTP {0}.")]
    HttpStatus(u16),
    #[error("L'adresse du modèle n'est pas un lien https valide.")]
    InvalidUrl,
    #[error("La réponse de voice-models.com est anormalement volumineuse.")]
    ListingTooLarge,
    #[error(
        "Téléchargement trop long (plus de {0} minutes) : réessaie avec une meilleure connexion."
    )]
    DownloadDeadline(u64),
    #[error("Le modèle dépasse la limite autorisée de 1 Go.")]
    DownloadTooLarge,
    #[error("Le fichier téléchargé n'est pas une archive zip (lien Google Drive ou page web ?) : ce modèle ne peut pas être ajouté automatiquement.")]
    NotZip,
    #[error("Archive du modèle illisible : {0}")]
    Archive(String),
    #[error("L'archive ne contient aucun modèle RVC (.pth).")]
    NoModelInArchive,
    #[error("L'archive contient trop de fichiers (plus de 256) pour être un modèle RVC : elle a été refusée.")]
    TooManyEntries,
    #[error("L'archive contient un chemin de fichier dangereux : elle a été refusée.")]
    UnsafeArchive,
    #[error("Le contenu de l'archive dépasse la limite autorisée de 2 Go.")]
    ExtractedTooLarge,
    #[error("Erreur d'accès au fichier local : {0}")]
    Io(#[from] io::Error),
}

pub type Result<T> = std::result::Result<T, VoiceModelsError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModel {
    pub title: String,
    /// Size as displayed by the site, e.g. "88.59 MB"; empty when the site shows none.
    pub size: String,
    /// Absolute https URL of the model zip.
    pub download_url: String,
    /// Absolute URL of the model's page on voice-models.com.
    pub page_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPage {
    pub models: Vec<RemoteModel>,
    pub has_more: bool,
}

pub struct Client {
    base_url: String,
    listing: std::result::Result<HttpClient, String>,
    download: std::result::Result<HttpClient, String>,
    download_deadline: Duration,
    listing_deadline: Duration,
}

impl Client {
    pub fn new() -> Self {
        Self::with_base_url("https://voice-models.com")
    }

    /// For tests against a local server: plain http is then accepted for that origin only.
    pub fn with_base_url(base_url: &str) -> Self {
        let base_url = base_url.trim_end_matches('/').to_string();
        let base = Url::parse(&base_url).ok();

        let listing_base = base.clone();
        let listing = HttpClient::builder()
            .user_agent(USER_AGENT)
            .timeout(LISTING_TIMEOUT)
            .redirect(Policy::custom(move |attempt| {
                if attempt.previous().len() > MAX_REDIRECTS {
                    attempt.error("trop de redirections")
                } else if listing_base
                    .as_ref()
                    .is_some_and(|base| same_origin(base, attempt.url()))
                {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|error| error.to_string());

        let download_base = base;
        let download = HttpClient::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(DOWNLOAD_STALL_TIMEOUT)
            .redirect(Policy::custom(move |attempt| {
                if attempt.previous().len() > MAX_REDIRECTS {
                    attempt.error("trop de redirections")
                } else if is_allowed_download_url(download_base.as_ref(), attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.error("redirection vers une adresse non https refusée")
                }
            }))
            .build()
            .map_err(|error| error.to_string());

        Self {
            base_url,
            listing,
            download,
            download_deadline: DOWNLOAD_DEADLINE,
            listing_deadline: LISTING_TIMEOUT,
        }
    }

    /// Overrides the whole-listing budget (tests).
    pub fn with_listing_deadline(mut self, deadline: Duration) -> Self {
        self.listing_deadline = deadline;
        self
    }

    /// Overrides the whole-download budget (tests).
    pub fn with_download_deadline(mut self, deadline: Duration) -> Self {
        self.download_deadline = deadline;
        self
    }

    /// One page (one-based) of models; an empty query lists the whole catalogue.
    /// The whole request, body included, must finish within 15 s. Blocking reads only time out
    /// one by one, so the request runs on a worker thread and the caller stops waiting at the
    /// deadline; the worker gives up at its next read (deadline checked between reads).
    pub fn search(&self, query: &str, page: u32) -> Result<ModelPage> {
        let started = Instant::now();
        let base = self.base_url()?;
        let http = client(&self.listing)?.clone();
        let deadline = self.listing_deadline;
        let query = query.trim().to_string();
        let page = page.max(1);
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("voxbox-voicemodels-search".into())
            .spawn(move || {
                let _ = sender.send(fetch_listing(&http, &base, &query, page, started, deadline));
            })
            .map_err(|error| VoiceModelsError::Network(error.to_string()))?;
        match receiver.recv_timeout(deadline.saturating_sub(started.elapsed())) {
            Ok(result) => result,
            Err(_) => Err(listing_too_slow()),
        }
    }

    /// Streams the zip at `url` to `dest_dir/model.zip`, reporting progress in 0..=1 when the
    /// size is known. Only https URLs (and redirects) are followed; the size is capped at 1 GB and
    /// the whole transfer at 30 minutes.
    pub fn download(
        &self,
        url: &str,
        dest_dir: &Path,
        progress: &mut dyn FnMut(f32),
    ) -> Result<PathBuf> {
        let started = Instant::now();
        let url = Url::parse(url).map_err(|_| VoiceModelsError::InvalidUrl)?;
        let base = self.base_url().ok();
        if !is_allowed_download_url(base.as_ref(), &url) {
            return Err(VoiceModelsError::InvalidUrl);
        }
        let response = client(&self.download)?
            .get(url)
            .send()
            .map_err(|error| VoiceModelsError::Download(error.to_string()))?;
        let mut response = require_success(response)?;
        let total = response.content_length().filter(|length| *length > 0);
        if total.is_some_and(|length| length > MAX_DOWNLOAD_BYTES) {
            return Err(VoiceModelsError::DownloadTooLarge);
        }
        let is_html = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/html"));
        if is_html {
            return Err(VoiceModelsError::NotZip);
        }

        fs::create_dir_all(dest_dir)?;
        let mut temporary = NamedTempFile::new_in(dest_dir)?;
        let mut buffer = vec![0; 64 * 1024];
        let mut written: u64 = 0;
        let mut head: Vec<u8> = Vec::with_capacity(4);
        let mut reported = -1.0_f32;
        progress(0.0);
        loop {
            let count = response
                .read(&mut buffer)
                .map_err(|error| VoiceModelsError::Download(error.to_string()))?;
            if started.elapsed() > self.download_deadline {
                return Err(VoiceModelsError::DownloadDeadline(
                    self.download_deadline.as_secs() / 60,
                ));
            }
            if count == 0 {
                break;
            }
            if head.len() < 4 {
                let missing = (4 - head.len()).min(count);
                head.extend_from_slice(&buffer[..missing]);
                if head.len() == 4 && !looks_like_zip(&head) {
                    return Err(VoiceModelsError::NotZip);
                }
            }
            written += count as u64;
            if written > MAX_DOWNLOAD_BYTES {
                return Err(VoiceModelsError::DownloadTooLarge);
            }
            temporary.write_all(&buffer[..count])?;
            if let Some(total) = total {
                let fraction = (written as f32 / total as f32).min(1.0);
                if fraction - reported >= 0.01 {
                    reported = fraction;
                    progress(fraction);
                }
            }
        }
        if head.len() < 4 {
            return Err(VoiceModelsError::NotZip);
        }
        if total.is_some_and(|total| written < total) {
            return Err(VoiceModelsError::Download(
                "connexion coupée avant la fin".into(),
            ));
        }
        temporary.as_file().sync_all()?;
        progress(1.0);
        let destination = dest_dir.join("model.zip");
        temporary
            .persist(&destination)
            .map_err(|error| VoiceModelsError::Io(error.error))?;
        Ok(destination)
    }

    fn base_url(&self) -> Result<Url> {
        Url::parse(&self.base_url).map_err(|error| {
            VoiceModelsError::Network(format!("adresse de base invalide : {error}"))
        })
    }
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

fn listing_too_slow() -> VoiceModelsError {
    VoiceModelsError::Network("la liste des modèles met trop de temps à arriver".into())
}

fn fetch_listing(
    http: &HttpClient,
    base: &Url,
    query: &str,
    page: u32,
    started: Instant,
    deadline: Duration,
) -> Result<ModelPage> {
    let url = base
        .join("/fetch_data.php")
        .map_err(|error| VoiceModelsError::Network(error.to_string()))?;
    let page = page.to_string();
    let response = http
        .post(url)
        .form(&[("page", page.as_str()), ("search", query)])
        .send()
        .map_err(|error| VoiceModelsError::Network(error.to_string()))?;
    let mut response = require_success(response)?;
    if !same_origin(base, response.url()) {
        return Err(VoiceModelsError::InvalidUrl);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_LISTING_BYTES)
    {
        return Err(VoiceModelsError::ListingTooLarge);
    }
    let mut body = Vec::new();
    let mut buffer = [0; 16 * 1024];
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|error| VoiceModelsError::Network(error.to_string()))?;
        if started.elapsed() > deadline {
            return Err(listing_too_slow());
        }
        if count == 0 {
            break;
        }
        if (body.len() + count) as u64 > MAX_LISTING_BYTES {
            return Err(VoiceModelsError::ListingTooLarge);
        }
        body.extend_from_slice(&buffer[..count]);
    }
    let body = String::from_utf8(body)
        .map_err(|_| VoiceModelsError::Parse("réponse qui n'est pas en UTF-8".into()))?;
    parse_response(&body, base.as_str())
}

fn client(http: &std::result::Result<HttpClient, String>) -> Result<&HttpClient> {
    http.as_ref().map_err(|error| {
        VoiceModelsError::Network(format!("configuration du client impossible : {error}"))
    })
}

fn require_success(response: Response) -> Result<Response> {
    if !response.status().is_success() {
        return Err(VoiceModelsError::HttpStatus(response.status().as_u16()));
    }
    Ok(response)
}

/// Local file header, or the end-of-central-directory record of an empty archive.
fn looks_like_zip(head: &[u8]) -> bool {
    head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06")
}

/// Any https host without credentials, or the client's own origin (local test servers).
fn is_allowed_download_url(base: Option<&Url>, target: &Url) -> bool {
    if target.host_str().is_none() || !target.username().is_empty() || target.password().is_some() {
        return false;
    }
    target.scheme() == "https" || base.is_some_and(|base| same_origin(base, target))
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_download_url, looks_like_zip};
    use url::Url;

    #[test]
    fn downloads_require_https_except_for_the_client_origin() {
        let site = Url::parse("https://voice-models.com").unwrap();
        let ok = Url::parse("https://huggingface.co/a/resolve/main/x.zip").unwrap();
        let plain = Url::parse("http://huggingface.co/x.zip").unwrap();
        let creds = Url::parse("https://user:pw@huggingface.co/x.zip").unwrap(); // hepha-allow-secret: fake credentials, the URL must be refused
        let file = Url::parse("file:///etc/passwd").unwrap();
        assert!(is_allowed_download_url(Some(&site), &ok));
        assert!(!is_allowed_download_url(Some(&site), &plain));
        assert!(!is_allowed_download_url(Some(&site), &creds));
        assert!(!is_allowed_download_url(Some(&site), &file));

        let local = Url::parse("http://127.0.0.1:4000").unwrap();
        let same = Url::parse("http://127.0.0.1:4000/m.zip").unwrap();
        let other_port = Url::parse("http://127.0.0.1:4001/m.zip").unwrap();
        assert!(is_allowed_download_url(Some(&local), &same));
        assert!(!is_allowed_download_url(Some(&local), &other_port));
    }

    #[test]
    fn recognises_zip_signatures() {
        assert!(looks_like_zip(b"PK\x03\x04rest"));
        assert!(!looks_like_zip(b"<!doctype html>"));
    }
}
