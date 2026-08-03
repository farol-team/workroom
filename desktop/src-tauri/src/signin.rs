//! Signing in through the person's own browser.
//!
//! A native application cannot receive a redirect the way a website can. It
//! listens on the loopback interface and tells the server where (RFC 8252) —
//! which needs no registration with the operating system, behaves the same on
//! every platform, and cannot be hijacked by another application claiming the
//! same url scheme.
//!
//! What comes back is the bearer token this client already carries. No token of
//! the provider's reaches it, so the client's idea of identity does not change.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// What a callback carried.
#[derive(Debug, PartialEq, Eq)]
pub struct Callback {
    pub token: String,
    pub state: Option<String>,
}

/// `GET /?token=…&state=… HTTP/1.1`
///
/// A request with no token is not a callback — it is a stray browser, a probe,
/// or something else on this machine that found an open port.
pub fn parse_callback(request_line: &str) -> Option<Callback> {
    let target = request_line.split_whitespace().nth(1)?;
    let query = target.split_once('?')?.1;

    let mut token = None;
    let mut state = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        match key {
            "token" => token = Some(percent_decode(value)),
            "state" => state = Some(percent_decode(value)),
            _ => {}
        }
    }
    token
        .filter(|t| !t.is_empty())
        .map(|token| Callback { token, state })
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&String::from_utf8_lossy(&bytes[i + 1..i + 3]), 16)
            {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A value this sign-in can recognise on the way back.
///
/// It guards against a stray request finding an open port, which is what it is
/// for. It is not a secret and does not pretend to be one: the token itself is
/// what matters, and it travels to a listener on this machine only.
pub fn nonce(port: u16) -> String {
    // The clock cannot tell two sign-ins apart by itself: where its granularity
    // is coarser than two back-to-back calls, the nanos repeat, and a nonce
    // that can repeat is not a nonce (#210). The counter is what tells them
    // apart within this process; the clock, across processes and restarts.
    static TAKEN: AtomicU64 = AtomicU64::new(0);
    let seq = TAKEN.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}-{:x}-{:x}", now, seq, port, std::process::id())
}

/// What the browser is left looking at. Plain, because the person's attention
/// belongs back in the application.
pub const DONE: &str = "You are signed in. You can close this window.";

fn respond(mut stream: TcpStream, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// Listen on a port the operating system picks, for one callback, once.
///
/// Bound to `127.0.0.1` rather than `0.0.0.0`: a listener holding somebody's
/// token must not be reachable from the network.
pub struct Listener {
    listener: TcpListener,
}

impl Listener {
    pub fn open() -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        Ok(Self { listener })
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    /// The first request that is actually a callback wins; anything else is
    /// answered and ignored, so a stray probe cannot end the wait.
    pub fn wait(self, timeout: Duration, expected_state: Option<&str>) -> Option<Callback> {
        let deadline = std::time::Instant::now() + timeout;
        self.listener.set_nonblocking(true).ok()?;

        while std::time::Instant::now() < deadline {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).ok()?;
                    let mut line = String::new();
                    let mut reader = BufReader::new(stream.try_clone().ok()?);
                    let _ = reader.read_line(&mut line);
                    respond(stream, DONE);

                    if let Some(callback) = parse_callback(&line) {
                        if expected_state.is_none() || callback.state.as_deref() == expected_state {
                            return Some(callback);
                        }
                    }
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn a_callback_carries_the_token_the_server_issued() {
        let got = parse_callback("GET /?token=abc123&state=nonce HTTP/1.1").unwrap();

        assert_eq!(got.token, "abc123");
        assert_eq!(got.state.as_deref(), Some("nonce"));
    }

    #[test]
    fn the_order_of_the_query_is_not_ours_to_assume() {
        let got = parse_callback("GET /?state=nonce&token=abc123 HTTP/1.1").unwrap();

        assert_eq!(got.token, "abc123");
    }

    #[test]
    fn a_request_with_no_token_is_not_a_callback() {
        // A browser that wandered in, a probe, or something else on this
        // machine that found an open port.
        assert!(parse_callback("GET / HTTP/1.1").is_none());
        assert!(parse_callback("GET /?state=nonce HTTP/1.1").is_none());
        assert!(parse_callback("GET /?token= HTTP/1.1").is_none());
        assert!(parse_callback("nonsense").is_none());
    }

    #[test]
    fn an_escaped_token_arrives_as_itself() {
        let got = parse_callback("GET /?token=a%2Bb%2Fc%3D HTTP/1.1").unwrap();

        assert_eq!(got.token, "a+b/c=");
    }

    #[test]
    fn two_sign_ins_do_not_share_a_nonce() {
        assert_ne!(nonce(51_732), nonce(51_733));
        assert_ne!(nonce(51_732), nonce(51_732), "nor two on the same port");
    }

    #[test]
    fn the_listener_is_on_the_loopback_interface_and_a_port_it_was_given() {
        let listener = Listener::open().unwrap();

        assert_eq!(
            listener.listener.local_addr().unwrap().ip(),
            Ipv4Addr::LOCALHOST,
            "a listener holding a token must not be reachable from the network"
        );
        assert!(
            listener.port() >= 1024,
            "a port a listener could actually be given"
        );
    }

    #[test]
    fn waiting_ends_rather_than_hanging_forever() {
        let listener = Listener::open().unwrap();

        assert_eq!(
            listener.wait(Duration::from_millis(150), None),
            None,
            "a sign-in nobody completes must not hold the application open"
        );
    }

    #[test]
    fn a_callback_bearing_the_wrong_state_is_not_this_sign_in() {
        let listener = Listener::open().unwrap();
        let port = listener.port();

        std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            let _ = stream.write_all(b"GET /?token=stolen&state=somebody-elses HTTP/1.1\r\n\r\n");
        });

        assert_eq!(
            listener.wait(Duration::from_millis(400), Some("ours")),
            None
        );
    }

    #[test]
    fn the_browser_hands_the_token_over_and_is_told_it_is_done() {
        let listener = Listener::open().unwrap();
        let port = listener.port();

        let browser = std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            stream
                .write_all(b"GET /?token=abc123&state=ours HTTP/1.1\r\n\r\n")
                .unwrap();
            let mut said = String::new();
            let _ = BufReader::new(stream).read_to_string(&mut said);
            said
        });

        let got = listener.wait(Duration::from_secs(3), Some("ours")).unwrap();
        assert_eq!(got.token, "abc123");
        assert!(browser.join().unwrap().contains(DONE));
    }
}
