//! Pack discovery and download against a local HTTP server. The manifest fixtures are signed
//! with a throwaway key by the real Tauri CLI (`tauri signer sign`).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use voxbox_aipack::{verify_manifest, AiPackError, Client, PackRelease};

const PUBKEY: &str = include_str!("fixtures/pubkey.b64");
const OTHER_PUBKEY: &str = include_str!("fixtures/other_pubkey.b64");
const MANIFEST: &[u8] = include_bytes!("fixtures/manifest.json");
const SIGNATURE: &str = include_str!("fixtures/manifest.json.sig");
const INSTALLER: &[u8] = include_bytes!("fixtures/installer.bin");
const SHA256: &str = "fef6689acd9011dc45034ad2bc7570f06536086f220cd9aacbfba73170814cc9";

/// Assets of a release, as (name, size).
type Assets<'a> = &'a [(&'a str, u64)];
/// A release of the listing: (tag, draft, prerelease, assets).
type Release<'a> = (&'a str, bool, bool, Assets<'a>);

fn listing(base: &str, releases: &[Release<'_>]) -> String {
    let releases: Vec<serde_json::Value> = releases
        .iter()
        .map(|(tag, draft, prerelease, assets)| {
            serde_json::json!({
                "tag_name": tag,
                "draft": draft,
                "prerelease": prerelease,
                "assets": assets.iter().map(|(name, size)| serde_json::json!({
                    "name": name,
                    "size": size,
                    "browser_download_url": format!("{base}/download/{tag}/{name}"),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    serde_json::Value::Array(releases).to_string()
}

const COMPLETE: &[(&str, u64)] = &[
    ("VoxBox-Voix-IA-setup.exe", 20),
    ("ai-pack-manifest.json", 152),
    ("ai-pack-manifest.json.sig", 392),
];

#[test]
fn the_fixture_manifest_is_signed_with_the_fixture_key() {
    let manifest = verify_manifest(MANIFEST, SIGNATURE, PUBKEY).expect("valid signature");
    assert_eq!(manifest.version, 14);
    assert_eq!(manifest.file, "VoxBox-Voix-IA-setup.exe");
    assert_eq!(manifest.size, INSTALLER.len() as u64);
    assert_eq!(manifest.sha256, SHA256);
}

#[test]
fn a_manifest_changed_or_signed_with_another_key_is_refused() {
    let tampered = String::from_utf8(MANIFEST.to_vec())
        .unwrap()
        .replace("14", "15");
    assert!(matches!(
        verify_manifest(tampered.as_bytes(), SIGNATURE, PUBKEY),
        Err(AiPackError::Signature(_))
    ));
    assert!(matches!(
        verify_manifest(MANIFEST, SIGNATURE, OTHER_PUBKEY),
        Err(AiPackError::Signature(_))
    ));
    assert!(matches!(
        verify_manifest(MANIFEST, "not base64 !", PUBKEY),
        Err(AiPackError::Signature(_))
    ));
}

#[test]
fn latest_picks_the_newest_complete_published_pack_and_authenticates_it() {
    let server = TestServer::start_with(|base| {
        let releases = listing(
            base,
            &[
                // Newer, but a draft, a prerelease, or without a manifest (older packs): skipped.
                ("ai-pack-16", true, false, COMPLETE),
                ("ai-pack-15", false, true, COMPLETE),
                (
                    "ai-pack-17",
                    false,
                    false,
                    &[("VoxBox-Voix-IA-setup.exe", 20)],
                ),
                ("ai-pack-14", false, false, COMPLETE),
                ("ai-pack-13", false, false, COMPLETE),
                (
                    "v0.1.120",
                    false,
                    false,
                    &[("VoxBox_0.1.120_x64-setup.exe", 5)],
                ),
                ("ai-pack-018", false, false, COMPLETE),
            ],
        );
        vec![
            ResponseSpec::ok("application/json", releases),
            ResponseSpec::ok("application/json", MANIFEST),
            ResponseSpec::ok("application/octet-stream", SIGNATURE),
        ]
    });
    let release = Client::with_api_base(&format!("{}/repos/o/r", server.base_url))
        .latest(PUBKEY)
        .expect("latest succeeds")
        .expect("a pack is published");
    assert_eq!(release.version, 14);
    assert_eq!(release.size, 20);
    assert_eq!(release.sha256, SHA256);
    assert_eq!(
        release.installer_url,
        format!(
            "{}/download/ai-pack-14/VoxBox-Voix-IA-setup.exe",
            server.base_url
        )
    );
    let requests = server.finish();
    assert!(requests[0].starts_with("GET /repos/o/r/releases?per_page=100&page=1 "));
    assert!(requests[0]
        .to_ascii_lowercase()
        .contains("user-agent: voxbox"));
    assert!(requests[1].starts_with("GET /download/ai-pack-14/ai-pack-manifest.json "));
    assert!(requests[2].starts_with("GET /download/ai-pack-14/ai-pack-manifest.json.sig "));
}

#[test]
fn latest_reads_further_pages_when_app_releases_fill_the_first() {
    let server = TestServer::start_with(|base| {
        let app_releases: Vec<String> = (0..100).map(|n| format!("v0.1.{n}")).collect();
        let first: Vec<Release<'_>> = app_releases
            .iter()
            .map(|tag| (tag.as_str(), false, false, &[][..]))
            .collect();
        vec![
            ResponseSpec::ok("application/json", listing(base, &first)),
            ResponseSpec::ok(
                "application/json",
                listing(base, &[("ai-pack-14", false, false, COMPLETE)]),
            ),
            ResponseSpec::ok("application/json", MANIFEST),
            ResponseSpec::ok("application/octet-stream", SIGNATURE),
        ]
    });
    let release = Client::with_api_base(&format!("{}/repos/o/r", server.base_url))
        .latest(PUBKEY)
        .expect("latest succeeds");
    assert_eq!(release.map(|r| r.version), Some(14));
    let requests = server.finish();
    assert!(requests[1].starts_with("GET /repos/o/r/releases?per_page=100&page=2 "));
}

#[test]
fn latest_takes_the_highest_pack_of_every_page_not_the_first_found() {
    // Pack 14 published (or repaired) after pack 15: it is listed first, 15 is still the newest.
    let server = TestServer::start_with(|base| {
        let app_releases: Vec<String> = (0..99).map(|n| format!("v0.1.{n}")).collect();
        let mut first: Vec<Release<'_>> = vec![("ai-pack-14", false, false, COMPLETE)];
        first.extend(
            app_releases
                .iter()
                .map(|tag| (tag.as_str(), false, false, &[][..])),
        );
        vec![
            ResponseSpec::ok("application/json", listing(base, &first)),
            ResponseSpec::ok(
                "application/json",
                listing(base, &[("ai-pack-15", false, false, COMPLETE)]),
            ),
            ResponseSpec::ok("application/json", MANIFEST),
            ResponseSpec::ok("application/octet-stream", SIGNATURE),
        ]
    });
    let result = Client::with_api_base(&format!("{}/repos/o/r", server.base_url)).latest(PUBKEY);
    // The fixture manifest is signed for 14: chosen 15 is checked against it and refused, which
    // shows 15 (on page 2) was the one picked.
    assert!(
        matches!(result, Err(AiPackError::Mismatch(_))),
        "{result:?}"
    );
    let requests = server.finish();
    assert!(requests[2].starts_with("GET /download/ai-pack-15/ai-pack-manifest.json "));
}

/// `count` releases of app versions in full pages, the first one replaced by pack 14 if asked,
/// then the page after them.
fn long_listing(base: &str, with_pack: bool, after: Vec<serde_json::Value>) -> Vec<ResponseSpec> {
    let mut pages: Vec<ResponseSpec> = (0..10)
        .map(|page| {
            let mut releases: Vec<serde_json::Value> = (0..100)
                .map(|n| serde_json::json!({ "tag_name": format!("v{page}.{n}"), "assets": [] }))
                .collect();
            if with_pack && page == 0 {
                let pack: serde_json::Value =
                    serde_json::from_str(&listing(base, &[("ai-pack-14", false, false, COMPLETE)]))
                        .unwrap();
                releases[0] = pack[0].clone();
            }
            ResponseSpec::ok(
                "application/json",
                serde_json::Value::Array(releases).to_string(),
            )
        })
        .collect();
    pages.push(ResponseSpec::ok(
        "application/json",
        serde_json::Value::Array(after).to_string(),
    ));
    pages
}

#[test]
fn latest_says_when_the_listing_is_longer_than_it_reads() {
    // With or without a pack among the pages read: a higher one could be further.
    for with_pack in [false, true] {
        let server = TestServer::start_with(|base| {
            long_listing(
                base,
                with_pack,
                vec![serde_json::json!({ "tag_name": "v9.100", "assets": [] })],
            )
        });
        let result =
            Client::with_api_base(&format!("{}/repos/o/r", server.base_url)).latest(PUBKEY);
        assert!(
            matches!(result, Err(AiPackError::Parse(_))),
            "{with_pack}: {result:?}"
        );
        let requests = server.finish();
        assert_eq!(requests.len(), 11, "{with_pack}");
        assert!(requests[10].starts_with("GET /repos/o/r/releases?per_page=100&page=11 "));
    }
}

#[test]
fn latest_accepts_a_listing_of_exactly_the_pages_it_reads() {
    let server = TestServer::start_with(|base| {
        let mut responses = long_listing(base, true, Vec::new());
        responses.push(ResponseSpec::ok("application/json", MANIFEST));
        responses.push(ResponseSpec::ok("application/octet-stream", SIGNATURE));
        responses
    });
    let release = Client::with_api_base(&format!("{}/repos/o/r", server.base_url))
        .latest(PUBKEY)
        .expect("a complete listing of 1000 releases");
    assert_eq!(release.map(|r| r.version), Some(14));
    server.finish();
}

#[test]
fn latest_is_none_without_any_pack_carrying_a_manifest() {
    let server = TestServer::start_with(|base| {
        let releases = listing(
            base,
            &[(
                "ai-pack-13",
                false,
                false,
                &[("VoxBox-Voix-IA-setup.exe", 20)],
            )],
        );
        vec![ResponseSpec::ok("application/json", releases)]
    });
    let latest = Client::with_api_base(&format!("{}/repos/o/r", server.base_url)).latest(PUBKEY);
    assert!(matches!(latest, Ok(None)), "{latest:?}");
    server.finish();
}

#[test]
fn latest_refuses_a_manifest_that_does_not_describe_its_release() {
    // Signed for pack 14 but published as ai-pack-15: replaying an older manifest is refused.
    let replayed = TestServer::start_with(|base| {
        vec![
            ResponseSpec::ok(
                "application/json",
                listing(base, &[("ai-pack-15", false, false, COMPLETE)]),
            ),
            ResponseSpec::ok("application/json", MANIFEST),
            ResponseSpec::ok("application/octet-stream", SIGNATURE),
        ]
    });
    let result = Client::with_api_base(&format!("{}/repos/o/r", replayed.base_url)).latest(PUBKEY);
    assert!(
        matches!(result, Err(AiPackError::Mismatch(_))),
        "{result:?}"
    );
    replayed.finish();

    // An installer asset of another size than the signed one.
    let resized = TestServer::start_with(|base| {
        let assets: &[(&str, u64)] = &[
            ("VoxBox-Voix-IA-setup.exe", 21),
            ("ai-pack-manifest.json", 152),
            ("ai-pack-manifest.json.sig", 392),
        ];
        vec![
            ResponseSpec::ok(
                "application/json",
                listing(base, &[("ai-pack-14", false, false, assets)]),
            ),
            ResponseSpec::ok("application/json", MANIFEST),
            ResponseSpec::ok("application/octet-stream", SIGNATURE),
        ]
    });
    let result = Client::with_api_base(&format!("{}/repos/o/r", resized.base_url)).latest(PUBKEY);
    assert!(
        matches!(result, Err(AiPackError::Mismatch(_))),
        "{result:?}"
    );
    resized.finish();

    // Signed with another key than the app's.
    let foreign = TestServer::start_with(|base| {
        vec![
            ResponseSpec::ok(
                "application/json",
                listing(base, &[("ai-pack-14", false, false, COMPLETE)]),
            ),
            ResponseSpec::ok("application/json", MANIFEST),
            ResponseSpec::ok("application/octet-stream", SIGNATURE),
        ]
    });
    let result =
        Client::with_api_base(&format!("{}/repos/o/r", foreign.base_url)).latest(OTHER_PUBKEY);
    assert!(
        matches!(result, Err(AiPackError::Signature(_))),
        "{result:?}"
    );
    foreign.finish();
}

#[test]
fn latest_reports_http_errors_and_oversized_listings() {
    let server = TestServer::start(vec![
        ResponseSpec::status(403, "Forbidden"),
        ResponseSpec::length_only("application/json", 50_000_000),
    ]);
    let client = Client::with_api_base(&format!("{}/repos/o/r", server.base_url));
    assert!(matches!(
        client.latest(PUBKEY),
        Err(AiPackError::HttpStatus(403))
    ));
    assert!(matches!(client.latest(PUBKEY), Err(AiPackError::Parse(_))));
    server.finish();
}

fn release(base: &str, path: &str) -> PackRelease {
    PackRelease {
        version: 14,
        size: INSTALLER.len() as u64,
        sha256: SHA256.into(),
        installer_url: format!("{base}{path}"),
    }
}

#[test]
fn download_follows_redirects_checks_the_hash_and_reports_progress() {
    let server = TestServer::start_with(|base| {
        vec![
            ResponseSpec::redirect(&format!("{base}/cdn/setup.exe")),
            ResponseSpec::ok("application/octet-stream", INSTALLER),
        ]
    });
    let dir = tempfile::tempdir().unwrap();
    let mut progress = Vec::new();
    let path = Client::with_api_base(&format!("{}/repos/o/r", server.base_url))
        .download(
            &release(&server.base_url, "/dl/setup.exe"),
            dir.path(),
            &mut |done, total| progress.push((done, total)),
        )
        .expect("download succeeds");
    assert_eq!(
        path,
        dir.path().join(voxbox_aipack::cached_installer_name(14))
    );
    assert_eq!(std::fs::read(&path).unwrap(), INSTALLER);
    assert_eq!(progress.first(), Some(&(0, 20)));
    assert_eq!(progress.last(), Some(&(20, 20)));
    server.finish();
}

#[test]
fn download_keeps_nothing_when_the_installer_differs_from_the_manifest() {
    let server = TestServer::start(vec![
        // Same size, other bytes: the SHA-256 catches it.
        ResponseSpec::ok("application/octet-stream", "fake installer BYTES"),
        // Announced longer than the manifest.
        ResponseSpec::ok("application/octet-stream", "fake installer bytes, and more"),
        // No length, and more bytes than announced by the manifest.
        ResponseSpec::without_length(
            "application/octet-stream",
            b"fake installer bytes, and more".to_vec(),
        ),
        // Cut short.
        ResponseSpec::without_length("application/octet-stream", b"fake".to_vec()),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let client = Client::with_api_base(&format!("{}/repos/o/r", server.base_url));
    for _ in 0..4 {
        let result = client.download(
            &release(&server.base_url, "/dl/setup.exe"),
            dir.path(),
            &mut |_, _| {},
        );
        assert!(matches!(result, Err(AiPackError::Corrupted)), "{result:?}");
    }
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        0,
        "nothing kept"
    );
    server.finish();
}

#[test]
fn download_refuses_plain_http_outside_the_client_origin_and_stops_at_its_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let client = Client::with_api_base("https://api.github.com/repos/o/r");
    let result = client.download(
        &release("http://example.com", "/setup.exe"),
        dir.path(),
        &mut |_, _| {},
    );
    assert!(matches!(result, Err(AiPackError::InvalidUrl)), "{result:?}");

    let server = TestServer::start(vec![ResponseSpec::slow(
        "application/octet-stream",
        INSTALLER,
        Duration::from_millis(600),
    )]);
    let result = Client::with_api_base(&format!("{}/repos/o/r", server.base_url))
        .with_download_deadline(Duration::from_millis(200))
        .download(
            &release(&server.base_url, "/dl/setup.exe"),
            dir.path(),
            &mut |_, _| {},
        );
    assert!(
        matches!(result, Err(AiPackError::Deadline(_))),
        "{result:?}"
    );
    server.finish();
}

struct ResponseSpec {
    status: u16,
    reason: &'static str,
    content_type: Option<&'static str>,
    content_length: Option<u64>,
    location: Option<String>,
    body: Vec<u8>,
    /// Sends the first half of the body, waits, then the rest.
    pause: Option<Duration>,
}

impl ResponseSpec {
    fn ok(content_type: &'static str, body: impl AsRef<[u8]>) -> Self {
        let body = body.as_ref().to_vec();
        Self {
            status: 200,
            reason: "OK",
            content_type: Some(content_type),
            content_length: Some(body.len() as u64),
            location: None,
            body,
            pause: None,
        }
    }

    fn slow(content_type: &'static str, body: impl AsRef<[u8]>, pause: Duration) -> Self {
        Self {
            pause: Some(pause),
            ..Self::ok(content_type, body)
        }
    }

    /// Body delimited by the connection close: no Content-Length to trust.
    fn without_length(content_type: &'static str, body: Vec<u8>) -> Self {
        Self {
            content_length: None,
            ..Self::ok(content_type, body)
        }
    }

    fn status(status: u16, reason: &'static str) -> Self {
        Self {
            status,
            reason,
            content_type: None,
            content_length: Some(0),
            location: None,
            body: Vec::new(),
            pause: None,
        }
    }

    fn redirect(location: &str) -> Self {
        Self {
            location: Some(location.to_string()),
            ..Self::status(302, "Found")
        }
    }

    fn length_only(content_type: &'static str, content_length: u64) -> Self {
        Self {
            content_type: Some(content_type),
            content_length: Some(content_length),
            ..Self::status(200, "OK")
        }
    }

    fn write_to(self, stream: &mut TcpStream) {
        write!(stream, "HTTP/1.1 {} {}\r\n", self.status, self.reason).unwrap();
        if let Some(content_type) = self.content_type {
            write!(stream, "Content-Type: {content_type}\r\n").unwrap();
        }
        if let Some(length) = self.content_length {
            write!(stream, "Content-Length: {length}\r\n").unwrap();
        }
        if let Some(location) = self.location {
            write!(stream, "Location: {location}\r\n").unwrap();
        }
        write!(stream, "Connection: close\r\n\r\n").unwrap();
        // The client may hang up early (refused download): ignore broken pipes.
        let split = if self.pause.is_some() {
            self.body.len() / 2
        } else {
            self.body.len()
        };
        let _ = stream.write_all(&self.body[..split]);
        let _ = stream.flush();
        if let Some(pause) = self.pause {
            thread::sleep(pause);
            let _ = stream.write_all(&self.body[split..]);
            let _ = stream.flush();
        }
    }
}

struct TestServer {
    base_url: String,
    requests: Arc<Mutex<Vec<String>>>,
    worker: JoinHandle<()>,
}

impl TestServer {
    fn start(responses: Vec<ResponseSpec>) -> Self {
        Self::start_with(move |_| responses)
    }

    fn start_with(responses: impl FnOnce(&str) -> Vec<ResponseSpec>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let base_url = format!("http://{}", listener.local_addr().expect("address"));
        let responses = responses(&base_url);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let worker = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept HTTP request");
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .expect("set read timeout");
                let request = read_request(&mut stream);
                captured.lock().expect("request lock").push(request);
                response.write_to(&mut stream);
            }
        });
        Self {
            base_url,
            requests,
            worker,
        }
    }

    fn finish(self) -> Vec<String> {
        self.worker.join().expect("test server thread");
        let requests = self.requests.lock().expect("request lock").clone();
        requests
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let count = stream.read(&mut buffer).expect("read HTTP request");
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        if String::from_utf8_lossy(&request).contains("\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&request).to_string()
}
