use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tempfile::tempdir;
use url::Url;
use voxbox_myinstants::{Client, MyInstantsError, RemoteSound};

const SMALL_AUDIO: &[u8] = b"test-mp3-bytes";
const MAX_DOWNLOAD_BYTES: usize = 10_000_000;

#[test]
fn search_encodes_spaces_accents_and_ampersands() {
    let server = TestServer::start(vec![ResponseSpec::html("<html></html>")]);
    let page = Client::with_base_url(&server.base_url)
        .search("café & tea", 3)
        .expect("search succeeds");
    assert!(page.sounds.is_empty());

    let requests = server.finish();
    let target = request_target(&requests[0]);
    assert!(requests[0]
        .to_ascii_lowercase()
        .contains("user-agent: voxbox/0.1"));
    let parsed = Url::parse(&format!("http://localhost{target}")).expect("request target URL");
    let query = parsed.query_pairs().collect::<Vec<_>>();
    assert!(query
        .iter()
        .any(|(name, value)| name == "name" && value == "café & tea"));
    assert!(query
        .iter()
        .any(|(name, value)| name == "page" && value == "3"));
    assert!(target.contains("%C3%A9"));
    assert!(target.contains("%26"));
    assert!(target.contains('+'));
}

#[test]
fn trending_routes_use_the_default_and_explicit_region_paths() {
    let server = TestServer::start(vec![
        ResponseSpec::html("<html></html>"),
        ResponseSpec::html("<html></html>"),
    ]);
    let client = Client::with_base_url(&server.base_url);
    client.trending(2).expect("default trending succeeds");
    client
        .trending_region("fr", 1)
        .expect("French trending succeeds");
    assert!(matches!(
        client.trending_region("../evil", 1),
        Err(MyInstantsError::InvalidRegion)
    ));

    let requests = server.finish();
    assert_eq!(request_target(&requests[0]), "/en/trending/?page=2");
    assert_eq!(request_target(&requests[1]), "/en/trending/fr/?page=1");
}

#[test]
fn follows_country_redirect_only_on_the_configured_host() {
    let server = TestServer::start(vec![
        ResponseSpec::redirect("/en/trending/fr/?page=1"),
        ResponseSpec::html(include_str!("../tests/fixtures/trending_fr.html")),
    ]);
    let page = Client::with_base_url(&server.base_url)
        .trending(1)
        .expect("same-host country redirect succeeds");
    assert!(!page.sounds.is_empty());
    let requests = server.finish();
    assert_eq!(request_target(&requests[0]), "/en/trending/?page=1");
    assert_eq!(request_target(&requests[1]), "/en/trending/fr/?page=1");

    let server = TestServer::start(vec![ResponseSpec::redirect("http://example.invalid/away")]);
    let result = Client::with_base_url(&server.base_url).trending(1);
    assert!(matches!(result, Err(MyInstantsError::HttpStatus(302))));
    assert_eq!(server.finish().len(), 1);
}

#[test]
fn download_writes_audio_to_a_safe_file() {
    let server = TestServer::start(vec![ResponseSpec::audio(SMALL_AUDIO)]);
    let destination = tempdir().expect("temporary directory");
    let path = Client::with_base_url(&server.base_url)
        .download(
            &sound(&format!("{}/media/sounds/hello.mp3", server.base_url)),
            destination.path(),
        )
        .expect("audio download succeeds");

    assert!(path.starts_with(destination.path()));
    assert!(path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .ends_with(".mp3"));
    assert_eq!(std::fs::read(path).expect("downloaded file"), SMALL_AUDIO);
    assert_eq!(server.finish().len(), 1);
}

#[test]
fn download_rejects_files_over_10_mb() {
    let server = TestServer::start(vec![ResponseSpec::length_only(
        200,
        "OK",
        Some("audio/mpeg"),
        MAX_DOWNLOAD_BYTES as u64 + 1,
    )]);
    let destination = tempdir().expect("temporary directory");
    let result = Client::with_base_url(&server.base_url).download(
        &sound(&format!("{}/media/sounds/large.mp3", server.base_url)),
        destination.path(),
    );
    assert!(matches!(result, Err(MyInstantsError::DownloadTooLarge)));
    assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 0);
    server.finish();
}

#[test]
fn download_rejects_wrong_content_type_without_mp3_extension() {
    let server = TestServer::start(vec![ResponseSpec::new(
        200,
        "OK",
        Some("application/octet-stream"),
        SMALL_AUDIO.to_vec(),
    )]);
    let destination = tempdir().expect("temporary directory");
    let result = Client::with_base_url(&server.base_url).download(
        &sound(&format!("{}/media/sounds/audio.bin", server.base_url)),
        destination.path(),
    );
    assert!(matches!(result, Err(MyInstantsError::InvalidContentType)));
    assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 0);
    server.finish();
}

#[test]
fn download_surfaces_not_found_status() {
    let server = TestServer::start(vec![ResponseSpec::new(
        404,
        "Not Found",
        Some("text/html"),
        b"not found".to_vec(),
    )]);
    let destination = tempdir().expect("temporary directory");
    let result = Client::with_base_url(&server.base_url).download(
        &sound(&format!("{}/media/sounds/missing.mp3", server.base_url)),
        destination.path(),
    );
    assert!(matches!(result, Err(MyInstantsError::HttpStatus(404))));
    server.finish();
}

#[test]
fn download_rejects_urls_outside_the_configured_host() {
    let server = TestServer::start(Vec::new());
    let destination = tempdir().expect("temporary directory");
    let client = Client::with_base_url(&server.base_url);

    for url in ["https://example.invalid/sound.mp3", "file:///tmp/sound.mp3"] {
        assert!(matches!(
            client.download(&sound(url), destination.path()),
            Err(MyInstantsError::InvalidUrl)
        ));
    }
    assert!(server.finish().is_empty());
}

#[test]
fn refuses_to_overwrite_an_existing_different_file() {
    let server = TestServer::start(vec![
        ResponseSpec::audio(SMALL_AUDIO),
        ResponseSpec::audio(SMALL_AUDIO),
    ]);
    let destination = tempdir().expect("temporary directory");
    let client = Client::with_base_url(&server.base_url);
    let remote_sound = sound(&format!("{}/media/sounds/hello.mp3", server.base_url));
    let path = client
        .download(&remote_sound, destination.path())
        .expect("first download succeeds");
    std::fs::write(&path, b"other contents").unwrap();

    let result = client.download(&remote_sound, destination.path());
    assert!(matches!(result, Err(MyInstantsError::FileConflict)));
    assert_eq!(std::fs::read(path).unwrap(), b"other contents");
    server.finish();
}

#[test]
#[ignore = "requires access to myinstants.com"]
fn live_myinstants_search_smoke_test() {
    let client = Client::new();
    let trending = client
        .trending(1)
        .expect("live MyInstants trending succeeds");
    assert!(!trending.sounds.is_empty());
    let french_trending = client
        .trending_region("fr", 1)
        .expect("live French MyInstants trending succeeds");
    assert!(!french_trending.sounds.is_empty());
    let page = client
        .search("bruh", 1)
        .expect("live MyInstants search succeeds");
    assert!(!page.sounds.is_empty());
}

fn sound(mp3_url: &str) -> RemoteSound {
    RemoteSound {
        title: "hello".to_string(),
        mp3_url: mp3_url.to_string(),
        page_url: "http://example.invalid/en/instant/hello/".to_string(),
    }
}

fn request_target(request_line: &str) -> &str {
    request_line.split_ascii_whitespace().nth(1).unwrap()
}

struct ResponseSpec {
    status: u16,
    reason: &'static str,
    content_type: Option<&'static str>,
    content_length: Option<u64>,
    location: Option<String>,
    body: Vec<u8>,
}

impl ResponseSpec {
    fn new(
        status: u16,
        reason: &'static str,
        content_type: Option<&'static str>,
        body: Vec<u8>,
    ) -> Self {
        Self {
            status,
            reason,
            content_type,
            content_length: Some(body.len() as u64),
            location: None,
            body,
        }
    }

    fn html(body: impl AsRef<[u8]>) -> Self {
        Self::new(
            200,
            "OK",
            Some("text/html; charset=utf-8"),
            body.as_ref().to_vec(),
        )
    }

    fn audio(body: &[u8]) -> Self {
        Self::new(200, "OK", Some("audio/mpeg"), body.to_vec())
    }

    fn redirect(location: &str) -> Self {
        Self {
            status: 302,
            reason: "Found",
            content_type: None,
            content_length: Some(0),
            location: Some(location.to_string()),
            body: Vec::new(),
        }
    }

    fn length_only(
        status: u16,
        reason: &'static str,
        content_type: Option<&'static str>,
        content_length: u64,
    ) -> Self {
        Self {
            status,
            reason,
            content_type,
            content_length: Some(content_length),
            location: None,
            body: Vec::new(),
        }
    }

    fn write_to(self, stream: &mut TcpStream) {
        write!(stream, "HTTP/1.1 {} {}\r\n", self.status, self.reason).unwrap();
        if let Some(content_type) = self.content_type {
            write!(stream, "Content-Type: {content_type}\r\n").unwrap();
        }
        if let Some(content_length) = self.content_length {
            write!(stream, "Content-Length: {content_length}\r\n").unwrap();
        }
        if let Some(location) = self.location {
            write!(stream, "Location: {location}\r\n").unwrap();
        }
        write!(stream, "Connection: close\r\n\r\n").unwrap();
        stream.write_all(&self.body).unwrap();
        stream.flush().unwrap();
    }
}

struct TestServer {
    base_url: String,
    requests: Arc<Mutex<Vec<String>>>,
    worker: JoinHandle<()>,
}

impl TestServer {
    fn start(responses: Vec<ResponseSpec>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address = listener.local_addr().expect("listener address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured_requests = Arc::clone(&requests);
        let worker = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept HTTP request");
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .expect("set read timeout");
                let request = read_request(&mut stream);
                captured_requests
                    .lock()
                    .expect("request lock")
                    .push(request);
                response.write_to(&mut stream);
            }
        });

        Self {
            base_url: format!("http://{address}"),
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
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&request).to_string()
}
