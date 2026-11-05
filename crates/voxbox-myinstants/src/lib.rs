//! MyInstants client (no stable public API: listing pages are parsed as HTML).
//!
//! [`Client::trending`] follows MyInstants' default country selection, while
//! [`Client::trending_region`] selects a country explicitly. Page numbers are
//! one-based. All listing extraction is isolated in [`parse_listing`].

use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::blocking::{Client as HttpClient, Response};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use url::Url;

pub mod parser;

pub use parser::parse_listing;

const USER_AGENT: &str = "VoxBox/0.1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 10;
const MAX_DOWNLOAD_BYTES: u64 = 10_000_000;
const MAX_FILENAME_STEM_UTF16: usize = 120;

#[derive(Debug, thiserror::Error)]
pub enum MyInstantsError {
    #[error("MyInstants est injoignable : {0}")]
    Network(String),
    #[error("la page MyInstants a changé de format : {0}")]
    Parse(String),
    #[error("MyInstants a répondu avec le statut HTTP {0}.")]
    HttpStatus(u16),
    #[error("Le fichier audio dépasse la limite autorisée de 10 Mo.")]
    DownloadTooLarge,
    #[error("Le contenu téléchargé n'est pas reconnu comme un fichier audio.")]
    InvalidContentType,
    #[error("L'adresse du son ne correspond pas à un hôte MyInstants autorisé.")]
    InvalidUrl,
    #[error("La région MyInstants est invalide.")]
    InvalidRegion,
    #[error("Le nom de fichier existe déjà avec un contenu différent.")]
    FileConflict,
    #[error("Erreur d'accès au fichier local : {0}")]
    Io(#[from] io::Error),
}

pub type Result<T> = std::result::Result<T, MyInstantsError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSound {
    pub title: String,
    /// Absolute URL of the mp3.
    pub mp3_url: String,
    /// Absolute URL of the sound's page on myinstants.com.
    pub page_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub sounds: Vec<RemoteSound>,
    pub has_more: bool,
}

pub struct Client {
    base_url: String,
    http: std::result::Result<HttpClient, String>,
}

impl Client {
    pub fn new() -> Self {
        Self::with_base_url("https://www.myinstants.com")
    }

    /// For tests against a local server.
    pub fn with_base_url(base_url: &str) -> Self {
        let base_url = base_url.trim_end_matches('/').to_string();
        let base = Url::parse(&base_url).ok();
        let redirect_base = base.clone();
        let http = HttpClient::builder()
            .user_agent(USER_AGENT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(Policy::custom(move |attempt| {
                if attempt.previous().len() > MAX_REDIRECTS {
                    attempt.error("trop de redirections MyInstants")
                } else if redirect_base
                    .as_ref()
                    .is_some_and(|base| is_allowed_site_redirect(base, attempt.url()))
                {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|error| error.to_string());

        Self { base_url, http }
    }

    /// Fetches the site's default trending list, which follows its country redirect.
    pub fn trending(&self, page: u32) -> Result<SearchPage> {
        let mut url = self.listing_url("/en/trending/")?;
        set_page(&mut url, page);
        self.fetch_listing(url)
    }

    /// Fetches trending sounds for a region such as `fr`.
    pub fn trending_region(&self, region: &str, page: u32) -> Result<SearchPage> {
        if region.is_empty()
            || !region
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
            || !region.bytes().any(|byte| byte.is_ascii_lowercase())
        {
            return Err(MyInstantsError::InvalidRegion);
        }

        let mut url = self.listing_url(&format!("/en/trending/{region}/"))?;
        set_page(&mut url, page);
        self.fetch_listing(url)
    }

    pub fn search(&self, query: &str, page: u32) -> Result<SearchPage> {
        let mut url = self.listing_url("/en/search/")?;
        url.query_pairs_mut()
            .append_pair("name", query)
            .append_pair("page", &page.max(1).to_string());
        self.fetch_listing(url)
    }

    pub fn download(&self, sound: &RemoteSound, dest_dir: &Path) -> Result<PathBuf> {
        let sound_url = Url::parse(&sound.mp3_url).map_err(|_| MyInstantsError::InvalidUrl)?;
        let base = self.base_url()?;
        if !is_allowed_download_url(&base, &sound_url) {
            return Err(MyInstantsError::InvalidUrl);
        }

        let response = self
            .http_client()?
            .get(sound_url.clone())
            .send()
            .map_err(|error| MyInstantsError::Network(error.to_string()))?;
        let response = require_success(response)?;
        if !is_allowed_download_url(&base, response.url()) {
            return Err(MyInstantsError::InvalidUrl);
        }

        if response
            .content_length()
            .is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
        {
            return Err(MyInstantsError::DownloadTooLarge);
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        let has_audio_content_type = content_type
            .split(';')
            .next()
            .is_some_and(|mime| mime.trim().to_ascii_lowercase().starts_with("audio/"));
        let has_mp3_extension = sound_url.path().to_ascii_lowercase().ends_with(".mp3")
            || response.url().path().to_ascii_lowercase().ends_with(".mp3");
        if !has_audio_content_type && !has_mp3_extension {
            return Err(MyInstantsError::InvalidContentType);
        }

        let mut bytes = Vec::new();
        response
            .take(MAX_DOWNLOAD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| MyInstantsError::Network(error.to_string()))?;
        if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err(MyInstantsError::DownloadTooLarge);
        }

        let filename = download_filename(&sound.title, &sound.mp3_url);
        persist_atomically(dest_dir, &filename, &bytes)
    }

    fn listing_url(&self, path: &str) -> Result<Url> {
        self.base_url()?
            .join(path)
            .map_err(|error| MyInstantsError::Network(error.to_string()))
    }

    fn base_url(&self) -> Result<Url> {
        Url::parse(&self.base_url).map_err(|error| {
            MyInstantsError::Network(format!("adresse de base invalide : {error}"))
        })
    }

    fn http_client(&self) -> Result<&HttpClient> {
        self.http.as_ref().map_err(|error| {
            MyInstantsError::Network(format!("configuration du client impossible : {error}"))
        })
    }

    fn fetch_listing(&self, url: Url) -> Result<SearchPage> {
        let response = self
            .http_client()?
            .get(url)
            .send()
            .map_err(|error| MyInstantsError::Network(error.to_string()))?;
        let response = require_success(response)?;
        if !is_allowed_site_response(&self.base_url()?, response.url()) {
            return Err(MyInstantsError::InvalidUrl);
        }
        let final_url = response.url().clone();
        let html = response
            .text()
            .map_err(|error| MyInstantsError::Network(error.to_string()))?;
        Ok(parse_listing(&html, final_url.as_str()))
    }
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

fn set_page(url: &mut Url, page: u32) {
    url.query_pairs_mut()
        .append_pair("page", &page.max(1).to_string());
}

fn require_success(response: Response) -> Result<Response> {
    if !response.status().is_success() {
        return Err(MyInstantsError::HttpStatus(response.status().as_u16()));
    }
    Ok(response)
}

fn is_allowed_site_redirect(base: &Url, target: &Url) -> bool {
    is_http_url(target)
        && target.scheme() == base.scheme()
        && allowed_host_with_port(base, target, true)
}

fn is_allowed_site_response(base: &Url, target: &Url) -> bool {
    is_http_url(target) && allowed_host_with_port(base, target, false)
}

fn is_allowed_download_url(base: &Url, target: &Url) -> bool {
    if !is_http_url(target) || !target.username().is_empty() || target.password().is_some() {
        return false;
    }
    allowed_host_with_port(base, target, true)
}

fn is_http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn allowed_host_with_port(base: &Url, target: &Url, allow_media_host: bool) -> bool {
    let (Some(base_host), Some(target_host)) = (base.host_str(), target.host_str()) else {
        return false;
    };

    if base_host.eq_ignore_ascii_case(target_host) {
        return base.scheme() == target.scheme()
            && base.port_or_known_default() == target.port_or_known_default();
    }

    if !is_official_myinstants_host(base_host) {
        return false;
    }

    let same_site_alias = is_official_myinstants_host(target_host);
    let media_host = allow_media_host && target_host.eq_ignore_ascii_case("media.myinstants.com");
    (same_site_alias || media_host)
        && base.scheme() == "https"
        && target.scheme() == "https"
        && target.port_or_known_default() == Some(443)
}

fn is_official_myinstants_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("myinstants.com") || host.eq_ignore_ascii_case("www.myinstants.com")
}

fn download_filename(title: &str, url: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{}-{:016x}.mp3", sanitize_filename(title), hasher.finish())
}

fn sanitize_filename(title: &str) -> String {
    let mut sanitized = title
        .trim()
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    sanitized = sanitized.trim_end_matches([' ', '.']).to_string();

    if reserved_windows_device_name(&sanitized) {
        sanitized.insert(0, '_');
    }

    let mut truncated = String::new();
    let mut utf16_units = 0;
    for character in sanitized.chars() {
        let character_units = character.len_utf16();
        if utf16_units + character_units > MAX_FILENAME_STEM_UTF16 {
            break;
        }
        truncated.push(character);
        utf16_units += character_units;
    }
    let truncated = truncated.trim_end_matches([' ', '.']);
    if truncated.is_empty() {
        "sound".to_string()
    } else {
        truncated.to_string()
    }
}

fn reserved_windows_device_name(name: &str) -> bool {
    let device = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            device.strip_prefix(prefix).is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        })
}

fn persist_atomically(dest_dir: &Path, filename: &str, bytes: &[u8]) -> Result<PathBuf> {
    fs::create_dir_all(dest_dir)?;
    let destination = dest_dir.join(filename);
    let mut temporary = NamedTempFile::new_in(dest_dir)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;

    match temporary.persist_noclobber(&destination) {
        Ok(_) => Ok(destination),
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
            drop(error.file);
            if fs::read(&destination)? == bytes {
                Ok(destination)
            } else {
                Err(MyInstantsError::FileConflict)
            }
        }
        Err(error) => Err(MyInstantsError::Io(error.error)),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        download_filename, is_allowed_download_url, sanitize_filename, MAX_FILENAME_STEM_UTF16,
    };
    use url::Url;

    #[test]
    fn sanitizes_windows_reserved_names_invalid_characters_and_trailing_dots() {
        assert_eq!(sanitize_filename("CON"), "_CON");
        assert_eq!(sanitize_filename("con.txt"), "_con.txt");
        assert!(!sanitize_filename("name... ").ends_with('.'));
        assert_eq!(sanitize_filename("bad/name\\sound?"), "bad_name_sound_");
    }

    #[test]
    fn preserves_unicode_and_caps_utf16_filename_length() {
        assert_eq!(sanitize_filename("音声 🥁"), "音声 🥁");
        let long = sanitize_filename(&"音".repeat(200));
        assert!(long.encode_utf16().count() <= MAX_FILENAME_STEM_UTF16);
        assert!(download_filename("音声", "https://www.myinstants.com/a.mp3").ends_with(".mp3"));
    }

    #[test]
    fn allows_only_the_site_and_its_media_host_for_downloads() {
        let base = Url::parse("https://www.myinstants.com").unwrap();
        let media = Url::parse("https://media.myinstants.com/media/sounds/a.mp3").unwrap();
        let foreign = Url::parse("https://myinstants.com.example.org/a.mp3").unwrap();
        let downgrade = Url::parse("http://www.myinstants.com/media/sounds/a.mp3").unwrap();

        assert!(is_allowed_download_url(&base, &media));
        assert!(!is_allowed_download_url(&base, &foreign));
        assert!(!is_allowed_download_url(&base, &downgrade));
    }
}
