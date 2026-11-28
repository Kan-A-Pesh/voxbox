//! Newer « VoxBox - Voix IA » packs, for the in-app pack update.
//!
//! Each pack is published in a GitHub release `ai-pack-<N>` (.github/workflows/ai-pack.yml)
//! with its NSIS installer, `ai-pack-manifest.json` (`{ version, file, size, sha256 }`) and
//! the manifest's minisign signature, made with the app's updater key. [`Client::latest`]
//! finds the newest complete release and authenticates it through that manifest;
//! [`Client::download`] streams the installer and checks it against the manifest. The installed
//! pack's version comes from `resources/ai-pack.json` ([`installed_version`]).

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use reqwest::blocking::{Client as HttpClient, Response};
use reqwest::redirect::Policy;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use url::Url;
use voxbox_net::same_origin;

/// Asset names of a pack release.
pub const INSTALLER_FILE: &str = "VoxBox-Voix-IA-setup.exe";
pub const MANIFEST_FILE: &str = "ai-pack-manifest.json";
pub const SIGNATURE_FILE: &str = "ai-pack-manifest.json.sig";
const TAG_PREFIX: &str = "ai-pack-";

const USER_AGENT: &str = "VoxBox";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Blocking reqwest applies this to each read: a stalled transfer fails, a slow one does not.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 10;
/// Releases per listing page (GitHub's maximum), and pages read at most: app and pack releases
/// share the listing, so packs can sit behind many app releases (one page today).
const RELEASES_PER_PAGE: usize = 100;
const MAX_PAGES: u32 = 10;
/// One page of the releases listing (100 releases with their assets) weighs well under this.
const MAX_LISTING_BYTES: u64 = 8_000_000;
/// The manifest and its signature are a few hundred bytes.
const MAX_SMALL_FILE_BYTES: u64 = 64 * 1024;
/// Largest installer announced by a manifest that is accepted (the pack weighs about 800 MB).
pub const MAX_INSTALLER_BYTES: u64 = 4_000_000_000;
/// Whole-download budget: 800 MB at about 0.2 MB/s.
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(90 * 60);

#[derive(Debug, thiserror::Error)]
pub enum AiPackError {
    #[error("GitHub est injoignable : {0}")]
    Network(String),
    #[error("GitHub a répondu avec le statut HTTP {0}.")]
    HttpStatus(u16),
    #[error("Réponse inattendue de GitHub : {0}")]
    Parse(String),
    #[error("Le pack publié n'a pas une signature valide : {0}")]
    Signature(String),
    #[error("Le pack publié est incohérent : {0}")]
    Mismatch(String),
    #[error("L'adresse du pack n'est pas un lien https valide.")]
    InvalidUrl,
    #[error("Téléchargement du pack interrompu : {0}")]
    Download(String),
    #[error("Le pack téléchargé ne correspond pas au pack publié (taille ou empreinte différente) : réessaie.")]
    Corrupted,
    #[error(
        "Téléchargement trop long (plus de {0} minutes) : réessaie avec une meilleure connexion."
    )]
    Deadline(u64),
    #[error("Erreur d'accès au fichier local : {0}")]
    Io(#[from] io::Error),
}

pub type Result<T> = std::result::Result<T, AiPackError>;

/// Name of the downloaded installer of pack `version` in the app's cache ([`Client::download`]).
pub fn cached_installer_name(version: u32) -> String {
    format!("VoxBox-Voix-IA-setup-{version}.exe")
}

/// The pack version of a cached installer name, or None for any other file (a partial
/// download). The inverse of [`cached_installer_name`].
pub fn cached_installer_version(name: &str) -> Option<u32> {
    let number = name
        .strip_prefix("VoxBox-Voix-IA-setup-")?
        .strip_suffix(".exe")?;
    let version: u32 = number.parse().ok()?;
    (cached_installer_name(version) == name).then_some(version)
}

/// `ai-pack-manifest.json`, once its signature is checked.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub file: String,
    pub size: u64,
    /// Lowercase hex SHA-256 of the installer.
    pub sha256: String,
}

/// A published pack whose manifest is authenticated and consistent with its release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackRelease {
    pub version: u32,
    pub size: u64,
    pub sha256: String,
    pub installer_url: String,
}

#[derive(Deserialize)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<ApiAsset>,
}

#[derive(Clone, Deserialize)]
struct ApiAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

/// Checks `signature_b64` (a Tauri `.sig` file: base64 of a minisign signature) over `manifest`
/// against `pubkey_b64` (`plugins.updater.pubkey` of tauri.conf.json), then parses it.
pub fn verify_manifest(manifest: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<Manifest> {
    let decode = |text: &str, what: &str| -> Result<String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(text.trim())
            .map_err(|_| AiPackError::Signature(format!("{what} illisible")))?;
        String::from_utf8(bytes).map_err(|_| AiPackError::Signature(format!("{what} illisible")))
    };
    let public_key = PublicKey::decode(&decode(pubkey_b64, "clé publique")?)
        .map_err(|error| AiPackError::Signature(format!("clé publique : {error}")))?;
    let signature = Signature::decode(&decode(signature_b64, "signature")?)
        .map_err(|error| AiPackError::Signature(format!("signature : {error}")))?;
    // Prehashed signatures only (what the Tauri CLI writes): no legacy mode.
    public_key
        .verify(manifest, &signature, false)
        .map_err(|error| AiPackError::Signature(error.to_string()))?;
    let manifest: Manifest = serde_json::from_slice(manifest)
        .map_err(|error| AiPackError::Mismatch(format!("manifeste illisible ({error})")))?;
    let valid_hash = manifest.sha256.len() == 64
        && manifest
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid_hash || manifest.size == 0 || manifest.size > MAX_INSTALLER_BYTES {
        return Err(AiPackError::Mismatch("manifeste hors limites".into()));
    }
    Ok(manifest)
}

/// Version of the installed pack (`resources/ai-pack.json`), or None when the file is absent
/// or unreadable: packs published before ai-pack.json existed carry none.
pub fn installed_version(path: &Path) -> Option<u32> {
    #[derive(Deserialize)]
    struct Installed {
        version: u32,
    }
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Installed>(text.trim_start_matches('\u{feff}'))
        .ok()
        .map(|installed| installed.version)
}

/// A pack release carrying the installer, the manifest and its signature.
struct Candidate {
    version: u32,
    installer: ApiAsset,
    manifest: ApiAsset,
    signature: ApiAsset,
}

/// The highest canonical `ai-pack-<N>` of `releases` that is published (neither draft nor
/// prerelease) and complete.
fn newest_complete_pack(releases: &[ApiRelease]) -> Option<Candidate> {
    releases
        .iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let number = release.tag_name.strip_prefix(TAG_PREFIX)?;
            // Canonical numbers only: "ai-pack-013" or "ai-pack-+13" are not pack tags.
            let version: u32 = number.parse().ok()?;
            let asset = |name: &str| release.assets.iter().find(|a| a.name == name).cloned();
            (version.to_string() == number).then_some(())?;
            Some(Candidate {
                version,
                installer: asset(INSTALLER_FILE)?,
                manifest: asset(MANIFEST_FILE)?,
                signature: asset(SIGNATURE_FILE)?,
            })
        })
        .max_by_key(|candidate| candidate.version)
}

pub struct Client {
    api_base: String,
    http: std::result::Result<HttpClient, String>,
    download_deadline: Duration,
}

impl Client {
    /// `repo` is `owner/name` on GitHub.
    pub fn new(repo: &str) -> Self {
        Self::with_api_base(&format!("https://api.github.com/repos/{repo}"))
    }

    /// For tests against a local server: plain http is then accepted for that origin only.
    pub fn with_api_base(api_base: &str) -> Self {
        let api_base = api_base.trim_end_matches('/').to_string();
        let base = Url::parse(&api_base).ok();
        let http = HttpClient::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(STALL_TIMEOUT)
            .redirect(Policy::custom(move |attempt| {
                if attempt.previous().len() > MAX_REDIRECTS {
                    attempt.error("trop de redirections")
                } else if is_allowed_url(base.as_ref(), attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.error("redirection vers une adresse non https refusée")
                }
            }))
            .build()
            .map_err(|error| error.to_string());
        Self {
            api_base,
            http,
            download_deadline: DOWNLOAD_DEADLINE,
        }
    }

    /// Overrides the whole-download budget (tests).
    pub fn with_download_deadline(mut self, deadline: Duration) -> Self {
        self.download_deadline = deadline;
        self
    }

    /// The newest published pack: the highest `ai-pack-<N>` release (neither draft nor
    /// prerelease) carrying the installer, the manifest and its signature. Its manifest must be
    /// signed with `pubkey_b64` and describe that release (same N, same installer name and
    /// size). Releases without a manifest (packs published before it existed) are skipped.
    pub fn latest(&self, pubkey_b64: &str) -> Result<Option<PackRelease>> {
        // Pack numbers do not follow the listing order (a pack build can be published after a
        // later one, a draft repaired), so the highest number is taken across every page read.
        let mut newest: Option<Candidate> = None;
        let mut complete_listing = false;
        // One page past MAX_PAGES is read as a probe only: empty, the listing was complete
        // (exactly MAX_PAGES full pages); not empty, it is longer than what is read.
        for page in 1..=MAX_PAGES + 1 {
            let listing = self.get_bytes(
                &format!(
                    "{}/releases?per_page={RELEASES_PER_PAGE}&page={page}",
                    self.api_base
                ),
                MAX_LISTING_BYTES,
            )?;
            let releases: Vec<ApiRelease> = serde_json::from_slice(&listing)
                .map_err(|error| AiPackError::Parse(format!("liste des releases ({error})")))?;
            if page > MAX_PAGES {
                complete_listing = releases.is_empty();
                break;
            }
            if let Some(candidate) = newest_complete_pack(&releases) {
                if newest
                    .as_ref()
                    .is_none_or(|best| candidate.version > best.version)
                {
                    newest = Some(candidate);
                }
            }
            if releases.len() < RELEASES_PER_PAGE {
                complete_listing = true;
                break;
            }
        }
        if !complete_listing {
            // Neither "no pack published" nor a sure newest: the listing goes on past the pages
            // read, a higher pack could be further.
            return Err(AiPackError::Parse(format!(
                "plus de {} releases publiées : impossible de savoir quel pack est le dernier",
                RELEASES_PER_PAGE * MAX_PAGES as usize
            )));
        }
        let Some(Candidate {
            version,
            installer,
            manifest,
            signature,
        }) = newest
        else {
            return Ok(None);
        };
        let manifest_bytes =
            self.get_bytes(&manifest.browser_download_url, MAX_SMALL_FILE_BYTES)?;
        let signature_bytes =
            self.get_bytes(&signature.browser_download_url, MAX_SMALL_FILE_BYTES)?;
        let signature = String::from_utf8(signature_bytes)
            .map_err(|_| AiPackError::Signature("signature illisible".into()))?;
        let manifest = verify_manifest(&manifest_bytes, &signature, pubkey_b64)?;
        if manifest.version != version {
            return Err(AiPackError::Mismatch(format!(
                "la release {TAG_PREFIX}{version} annonce le pack {}",
                manifest.version
            )));
        }
        if manifest.file != INSTALLER_FILE || manifest.size != installer.size {
            return Err(AiPackError::Mismatch(
                "le manifeste ne décrit pas l'installateur publié".into(),
            ));
        }
        Ok(Some(PackRelease {
            version,
            size: manifest.size,
            sha256: manifest.sha256,
            installer_url: installer.browser_download_url,
        }))
    }

    /// Streams the installer of `release` to `dest_dir/<cached_installer_name(N)>`,
    /// reporting `(downloaded, total)` bytes. Only https URLs (and redirects) are followed; the
    /// file must match the manifest's size and SHA-256, else nothing is kept.
    pub fn download(
        &self,
        release: &PackRelease,
        dest_dir: &Path,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<PathBuf> {
        let started = Instant::now();
        let total = release.size;
        let mut response = self.get(&release.installer_url)?;
        if response
            .content_length()
            .is_some_and(|length| length != total)
        {
            return Err(AiPackError::Corrupted);
        }
        fs::create_dir_all(dest_dir)?;
        let mut temporary = NamedTempFile::new_in(dest_dir)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 256 * 1024];
        let mut written: u64 = 0;
        let mut reported: u64 = 0;
        progress(0, total);
        loop {
            let count = response
                .read(&mut buffer)
                .map_err(|error| AiPackError::Download(error.to_string()))?;
            if started.elapsed() > self.download_deadline {
                return Err(AiPackError::Deadline(self.download_deadline.as_secs() / 60));
            }
            if count == 0 {
                break;
            }
            written += count as u64;
            if written > total {
                return Err(AiPackError::Corrupted);
            }
            hasher.update(&buffer[..count]);
            temporary.write_all(&buffer[..count])?;
            // About every 1 %: enough for a progress bar, few events.
            if written - reported >= total / 100 || written == total {
                reported = written;
                progress(written, total);
            }
        }
        let digest = hasher.finalize();
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        if written != total || hex != release.sha256 {
            return Err(AiPackError::Corrupted);
        }
        temporary.as_file().sync_all()?;
        let destination = dest_dir.join(cached_installer_name(release.version));
        temporary
            .persist(&destination)
            .map_err(|error| AiPackError::Io(error.error))?;
        Ok(destination)
    }

    fn get(&self, url: &str) -> Result<Response> {
        let url = Url::parse(url).map_err(|_| AiPackError::InvalidUrl)?;
        if !is_allowed_url(Url::parse(&self.api_base).ok().as_ref(), &url) {
            return Err(AiPackError::InvalidUrl);
        }
        let http = self.http.as_ref().map_err(|error| {
            AiPackError::Network(format!("configuration du client impossible : {error}"))
        })?;
        let response = http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json, */*")
            .send()
            .map_err(|error| AiPackError::Network(error.to_string()))?;
        if !response.status().is_success() {
            return Err(AiPackError::HttpStatus(response.status().as_u16()));
        }
        Ok(response)
    }

    /// A whole small response, refused past `limit` bytes.
    fn get_bytes(&self, url: &str, limit: u64) -> Result<Vec<u8>> {
        let response = self.get(url)?;
        if response
            .content_length()
            .is_some_and(|length| length > limit)
        {
            return Err(AiPackError::Parse(
                "réponse anormalement volumineuse".into(),
            ));
        }
        let mut body = Vec::new();
        response
            .take(limit + 1)
            .read_to_end(&mut body)
            .map_err(|error| AiPackError::Network(error.to_string()))?;
        if body.len() as u64 > limit {
            return Err(AiPackError::Parse(
                "réponse anormalement volumineuse".into(),
            ));
        }
        Ok(body)
    }
}

/// Any https host without credentials, or the client's own origin (local test servers).
fn is_allowed_url(base: Option<&Url>, target: &Url) -> bool {
    if target.host_str().is_none() || !target.username().is_empty() || target.password().is_some() {
        return false;
    }
    target.scheme() == "https" || base.is_some_and(|base| same_origin(base, target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_the_client_origin_is_followed() {
        let api = Url::parse("http://127.0.0.1:4000/repos/o/r").unwrap();
        let ok = Url::parse("https://github.com/o/r/releases/download/x").unwrap();
        let local = Url::parse("http://127.0.0.1:4000/x").unwrap();
        let other = Url::parse("http://127.0.0.1:4001/x").unwrap();
        let plain = Url::parse("http://github.com/x").unwrap();
        let creds = Url::parse("https://u:p@github.com/x").unwrap(); // hepha-allow-secret: fake credentials, the URL must be refused
        assert!(is_allowed_url(Some(&api), &ok));
        assert!(is_allowed_url(Some(&api), &local));
        assert!(!is_allowed_url(Some(&api), &other));
        assert!(!is_allowed_url(None, &plain));
        assert!(!is_allowed_url(None, &creds));
    }

    #[test]
    fn cached_installer_names_round_trip() {
        assert_eq!(
            cached_installer_version(&cached_installer_name(15)),
            Some(15)
        );
        for other in [
            ".tmpA1b2",
            "VoxBox-Voix-IA-setup-015.exe",
            "VoxBox-Voix-IA-setup-15.exe.part",
        ] {
            assert_eq!(cached_installer_version(other), None, "{other}");
        }
    }

    #[test]
    fn reads_the_installed_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai-pack.json");
        assert_eq!(installed_version(&path), None, "absent");
        fs::write(&path, "\u{feff}{\"version\":14}\r\n").unwrap();
        assert_eq!(
            installed_version(&path),
            Some(14),
            "BOM and CRLF from PowerShell"
        );
        fs::write(&path, "{\"version\":\"14\"}").unwrap();
        assert_eq!(installed_version(&path), None, "not a number");
    }
}
