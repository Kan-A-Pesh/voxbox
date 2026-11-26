use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tempfile::tempdir;
use voxbox_voicemodels::{Client, VoiceModelsError};

const PAGE: &str = r#"{"table":"<tr><td><a href='/model/x1'>Mario [RVC v2]</a><span class='badge bg-secondary text-white ms-2'>55.2 MB</span><button data-clipboard-text='https://huggingface.co/a/resolve/main/mario.zip?download=true'></button></td></tr>","pagination":"<li class='page-item next'><a onclick=\"fetchData(2, 'mario')\"></a></li>"}"#;

#[test]
fn search_posts_the_page_and_the_encoded_query() {
    let server = TestServer::start(vec![ResponseSpec::ok("application/json", PAGE)]);
    let page = Client::with_base_url(&server.base_url)
        .search("  café & mario ", 3)
        .expect("search succeeds");
    assert_eq!(page.models.len(), 1);
    assert_eq!(page.models[0].title, "Mario [RVC v2]");
    assert_eq!(page.models[0].size, "55.2 MB");
    assert!(page.has_more);

    let requests = server.finish();
    assert!(requests[0].starts_with("POST /fetch_data.php "));
    assert!(requests[0]
        .to_ascii_lowercase()
        .contains("content-type: application/x-www-form-urlencoded"));
    assert!(requests[0].ends_with("page=3&search=caf%C3%A9+%26+mario"));
}

#[test]
fn search_reports_http_errors_and_format_changes() {
    let server = TestServer::start(vec![
        ResponseSpec::status(503, "Service Unavailable"),
        ResponseSpec::ok("text/html", "<html>maintenance</html>"),
    ]);
    let client = Client::with_base_url(&server.base_url);
    assert!(matches!(
        client.search("", 1),
        Err(VoiceModelsError::HttpStatus(503))
    ));
    assert!(matches!(
        client.search("", 1),
        Err(VoiceModelsError::Parse(_))
    ));
    server.finish();
}

#[test]
fn search_refuses_oversized_listings_with_or_without_a_length() {
    let mut huge = br#"{"table":""#.to_vec();
    huge.extend(std::iter::repeat_n(b'x', 4_000_001));
    huge.extend(br#"","pagination":""}"#);
    let server = TestServer::start(vec![
        ResponseSpec::length_only("application/json", 4_000_001),
        ResponseSpec::without_length("application/json", huge),
    ]);
    let client = Client::with_base_url(&server.base_url);
    for _ in 0..2 {
        assert!(matches!(
            client.search("", 1),
            Err(VoiceModelsError::ListingTooLarge)
        ));
    }
    server.finish();
}

#[test]
fn search_returns_at_its_deadline_while_the_server_still_holds_the_body() {
    let server = TestServer::start(vec![ResponseSpec::slow(
        "application/json",
        PAGE,
        Duration::from_secs(3),
    )]);
    let started = std::time::Instant::now();
    let result = Client::with_base_url(&server.base_url)
        .with_listing_deadline(Duration::from_millis(300))
        .search("", 1);
    let elapsed = started.elapsed();
    assert!(
        matches!(&result, Err(VoiceModelsError::Network(m)) if m.contains("trop de temps")),
        "{result:?}"
    );
    // Well before the server sends the rest of the body (3 s).
    assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
    server.finish();
}

#[test]
fn download_stops_past_its_total_deadline() {
    let mut zip = b"PK\x03\x04".to_vec();
    zip.extend(std::iter::repeat_n(1_u8, 100_000));
    let server = TestServer::start(vec![ResponseSpec::ok("application/zip", zip)]);
    let dir = tempdir().unwrap();
    let result = Client::with_base_url(&server.base_url)
        .with_download_deadline(Duration::ZERO)
        .download(
            &format!("{}/m.zip", server.base_url),
            dir.path(),
            &mut |_| {},
        );
    assert!(matches!(result, Err(VoiceModelsError::DownloadDeadline(0))));
    server.finish();
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        0,
        "no temp file left"
    );
}

#[test]
fn download_streams_to_disk_with_progress_and_follows_redirects() {
    let mut zip = b"PK\x03\x04".to_vec();
    zip.extend(std::iter::repeat_n(7_u8, 300_000));
    let server_zip = zip.clone();
    let server = TestServer::start_with(move |base| {
        vec![
            ResponseSpec::redirect(&format!("{base}/cdn/model.zip")),
            ResponseSpec::ok("application/zip", server_zip),
        ]
    });
    let dir = tempdir().unwrap();
    let mut steps = Vec::new();
    let path = Client::with_base_url(&server.base_url)
        .download(
            &format!("{}/resolve/model.zip", server.base_url),
            dir.path(),
            &mut |p| steps.push(p),
        )
        .expect("download succeeds");
    assert_eq!(std::fs::read(&path).unwrap(), zip);
    assert_eq!(steps.first(), Some(&0.0));
    assert_eq!(steps.last(), Some(&1.0));
    assert!(steps.len() > 2);
    assert!(steps.windows(2).all(|w| w[0] <= w[1]));
    let requests = server.finish();
    assert!(requests[1].starts_with("GET /cdn/model.zip "));
}

#[test]
fn download_refuses_html_pages_and_non_zip_bodies() {
    let server = TestServer::start(vec![
        ResponseSpec::ok("text/html; charset=utf-8", "<html>Google Drive</html>"),
        ResponseSpec::ok("application/octet-stream", "not a zip at all"),
    ]);
    let client = Client::with_base_url(&server.base_url);
    let dir = tempdir().unwrap();
    let url = format!("{}/m.zip", server.base_url);
    assert!(matches!(
        client.download(&url, dir.path(), &mut |_| {}),
        Err(VoiceModelsError::NotZip)
    ));
    assert!(matches!(
        client.download(&url, dir.path(), &mut |_| {}),
        Err(VoiceModelsError::NotZip)
    ));
    server.finish();
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        0,
        "no temp file left"
    );
}

#[test]
fn download_refuses_oversized_archives_from_their_length() {
    let server = TestServer::start(vec![ResponseSpec::length_only(
        "application/zip",
        voxbox_voicemodels::MAX_DOWNLOAD_BYTES + 1,
    )]);
    let dir = tempdir().unwrap();
    assert!(matches!(
        Client::with_base_url(&server.base_url).download(
            &format!("{}/m.zip", server.base_url),
            dir.path(),
            &mut |_| {}
        ),
        Err(VoiceModelsError::DownloadTooLarge)
    ));
    server.finish();
}

#[test]
fn download_refuses_plain_http_outside_the_client_origin() {
    let dir = tempdir().unwrap();
    let client = Client::new();
    for url in [
        "http://huggingface.co/m.zip",
        "file:///etc/passwd",
        "not a url",
    ] {
        assert!(matches!(
            client.download(url, dir.path(), &mut |_| {}),
            Err(VoiceModelsError::InvalidUrl)
        ));
    }
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

/// Reads the head and, when announced, the body (form POSTs).
fn read_request(stream: &mut TcpStream) -> String {
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let count = stream.read(&mut buffer).expect("read HTTP request");
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        let text = String::from_utf8_lossy(&request).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let length = text[..end]
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            if request.len() >= end + 4 + length {
                break;
            }
        }
    }
    String::from_utf8_lossy(&request).to_string()
}
