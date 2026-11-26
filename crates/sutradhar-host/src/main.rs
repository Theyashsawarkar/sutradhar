//! sutradhar's native-messaging host. A browser starts it for the extension;
//! it relays between the browser (stdio: 4-byte little-endian length + JSON)
//! and the daemon (its unix socket: one JSON value per line). Byte for byte
//! what the Node host (packages/daemon/src/host.ts) does:
//!
//! - first, a `{"t":"meta","exe":...}` line naming the program that started
//!   it (Zen calls itself Firefox to extensions);
//! - browser → daemon: each message (any size the 4-byte length allows) is
//!   re-serialized as `JSON.stringify(JSON.parse(msg))` would, one per line;
//! - daemon → browser: each non-blank line is one message; a line longer than
//!   512 Ki UTF-16 units is cut into `part` frames, since a browser refuses a
//!   message over 1 MB from its host (the extension joins them);
//! - the socket closing ends it (0), a socket error too (1), stdin ending
//!   half-closes the socket and ends it (0).
//!
//! It never starts a daemon: systemd does when the host connects
//! (sutradhar.socket). std only; no threads beyond one per direction.

mod json;

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::exit;

/// Parts of at most this many UTF-16 code units (protocol/src/framing.ts PART_SIZE).
const PART_SIZE: usize = 512 * 1024;
const MAX_SOCKET_PATH: usize = 107;

unsafe extern "C" {
    fn getuid() -> u32;
}

/// The daemon's socket, as packages/daemon/src/paths.ts finds it.
fn socket_path(get: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    let var = |k: &str| get(k).filter(|v| !v.is_empty());
    if let Some(s) = var("SUTRADHAR_SOCKET") {
        return s.into();
    }
    if let Some(rt) = var("XDG_RUNTIME_DIR") {
        return Path::new(&rt).join("sutradhar").join("sock");
    }
    let home = var("HOME").unwrap_or_default();
    let state = var("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(&home).join(".local/state"));
    state.join("sutradhar").join("run").join("sock")
}

/// The socket's directory must be ours alone (pranali's rule): never talk to a socket someone else could have put there.
fn check_dir(dir: &Path, uid: u32) -> Result<(), String> {
    let st = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !st.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    if st.uid() != uid {
        return Err(format!(
            "{} belongs to uid {}, not you ({uid})",
            dir.display(),
            st.uid()
        ));
    }
    if st.mode() & 0o077 != 0 {
        return Err(format!(
            "{} is open to other users (mode {:o})",
            dir.display(),
            st.mode() & 0o777
        ));
    }
    Ok(())
}

/// JavaScript's `String.prototype.trim` whitespace: a line of only these is skipped, as the Node host's line reader does.
fn js_blank(s: &str) -> bool {
    s.chars().all(|c| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

/// The messages for one line from the daemon: the line itself, or its parts.
fn frames(line: &str, seq: &mut u64) -> Vec<Vec<u8>> {
    let units = line.encode_utf16().count();
    if units <= PART_SIZE {
        return vec![line.as_bytes().to_vec()];
    }
    *seq += 1;
    let all: Vec<u16> = line.encode_utf16().collect();
    let n = units.div_ceil(PART_SIZE);
    all.chunks(PART_SIZE)
        .enumerate()
        .map(|(i, chunk)| {
            let mut f = format!("{{\"t\":\"part\",\"pid\":\"p{seq}\",\"i\":{i},\"n\":{n},\"s\":").into_bytes();
            json::write_str16(&mut f, chunk);
            f.push(b'}');
            f
        })
        .collect()
}

fn write_native(out: &mut impl Write, body: &[u8]) -> io::Result<()> {
    out.write_all(&(body.len() as u32).to_le_bytes())?;
    out.write_all(body)?;
    out.flush()
}

/// The `meta` line: which program started us.
fn meta_line(exe: &str) -> Vec<u8> {
    let mut m = b"{\"t\":\"meta\",\"exe\":".to_vec();
    json::write_str(&mut m, exe);
    m.extend_from_slice(b"}\n");
    m
}

/// Daemon → browser, until the socket closes.
fn daemon_to_browser(sock: UnixStream) -> ! {
    let mut r = BufReader::with_capacity(64 * 1024, sock);
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut seq = 0;
    let mut line = Vec::new();
    loop {
        line.clear();
        match r.read_until(b'\n', &mut line) {
            Ok(0) => exit(0),
            Ok(_) => {}
            Err(_) => exit(1),
        }
        // A last piece without a newline is dropped, as the Node line reader does.
        if line.pop() != Some(b'\n') {
            exit(0);
        }
        let text = String::from_utf8_lossy(&line);
        if js_blank(&text) {
            continue;
        }
        for f in frames(&text, &mut seq) {
            if write_native(&mut out, &f).is_err() {
                exit(1);
            }
        }
    }
}

/// Browser → daemon, until stdin ends.
fn browser_to_daemon(mut sock: UnixStream) -> ! {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut buf = Vec::new();
    loop {
        let mut head = [0u8; 4];
        if input.read_exact(&mut head).is_err() {
            break;
        }
        let len = u32::from_le_bytes(head) as u64;
        buf.clear();
        // Grows as the message arrives: a bogus length can't make us allocate 4 GB up front.
        match (&mut input).take(len).read_to_end(&mut buf) {
            Ok(got) if got as u64 == len => {}
            _ => break, // ended mid-message: dropped, as Node did
        }
        let text = String::from_utf8_lossy(&buf);
        let mut line = match json::normalize(&text) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("sutradhar-host: the browser sent a message that isn't JSON ({e})");
                exit(1);
            }
        };
        line.push(b'\n');
        if sock.write_all(&line).is_err() {
            exit(1);
        }
    }
    let _ = sock.shutdown(Shutdown::Write);
    exit(0);
}

fn main() {
    let path = socket_path(&|k| std::env::var(k).ok());
    let fail = |msg: String| -> ! {
        eprintln!("sutradhar-host: {msg}");
        exit(1);
    };
    if path.as_os_str().len() > MAX_SOCKET_PATH {
        fail(format!(
            "socket path too long ({} bytes): {}",
            path.as_os_str().len(),
            path.display()
        ));
    }
    let dir = path.parent().unwrap_or(Path::new("/"));
    if let Err(e) = check_dir(dir, unsafe { getuid() }) {
        fail(format!("refusing to connect: {e}"));
    }
    let sock = UnixStream::connect(&path).unwrap_or_else(|e| {
        fail(format!(
            "no sutradhar daemon at {} ({e}); systemctl --user start sutradhar.socket",
            path.display()
        ))
    });
    let exe = std::fs::read_link(format!("/proc/{}/exe", std::os::unix::process::parent_id()))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut w = sock.try_clone().unwrap_or_else(|e| fail(e.to_string()));
    if w.write_all(&meta_line(&exe)).is_err() {
        exit(1);
    }
    let r = sock;
    std::thread::spawn(move || daemon_to_browser(r));
    browser_to_daemon(w);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        let v: Vec<(&str, &str)> = pairs.to_vec();
        move |k| v.iter().find(|(a, _)| *a == k).map(|(_, b)| b.to_string())
    }

    #[test]
    fn socket_follows_paths_ts() {
        assert_eq!(
            socket_path(&env_of(&[("SUTRADHAR_SOCKET", "/x/s"), ("XDG_RUNTIME_DIR", "/r")])),
            PathBuf::from("/x/s")
        );
        assert_eq!(
            socket_path(&env_of(&[("XDG_RUNTIME_DIR", "/run/user/7")])),
            PathBuf::from("/run/user/7/sutradhar/sock")
        );
        assert_eq!(
            socket_path(&env_of(&[("HOME", "/h")])),
            PathBuf::from("/h/.local/state/sutradhar/run/sock")
        );
        assert_eq!(
            socket_path(&env_of(&[("HOME", "/h"), ("XDG_STATE_HOME", "/s")])),
            PathBuf::from("/s/sutradhar/run/sock")
        );
        assert_eq!(
            socket_path(&env_of(&[("HOME", "/h"), ("XDG_RUNTIME_DIR", "")])),
            PathBuf::from("/h/.local/state/sutradhar/run/sock")
        );
    }

    #[test]
    fn dir_must_be_private() {
        let uid = unsafe { getuid() };
        let base = std::env::temp_dir().join(format!("sutradhar-host-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir(&base).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(check_dir(&base, uid).is_ok());
        assert!(check_dir(&base, uid + 1).unwrap_err().contains("belongs to"));
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(check_dir(&base, uid).unwrap_err().contains("open to other users"));
        let link = base.with_extension("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&base, &link).unwrap();
        assert!(check_dir(&link, uid).unwrap_err().contains("not a directory"));
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn small_lines_go_whole_big_ones_in_parts() {
        let mut seq = 0;
        assert_eq!(frames("{\"a\":1}", &mut seq), vec![b"{\"a\":1}".to_vec()]);
        assert_eq!(seq, 0);
        let big = format!("\"{}\"", "x".repeat(PART_SIZE * 2));
        let f = frames(&big, &mut seq);
        assert_eq!(f.len(), 3);
        assert!(f[0].starts_with(b"{\"t\":\"part\",\"pid\":\"p1\",\"i\":0,\"n\":3,\"s\":\"\\\"xxx"));
        assert!(f[2].ends_with(b"x\\\"\"}"));
        // A pair cut at the boundary: two lone-surrogate escapes, as JSON.stringify writes them.
        let cut = format!("{}😀", "a".repeat(PART_SIZE - 1));
        let f = frames(&cut, &mut seq);
        assert!(f[0].ends_with(b"a\\ud83d\"}"));
        assert_eq!(
            f[1],
            b"{\"t\":\"part\",\"pid\":\"p2\",\"i\":1,\"n\":2,\"s\":\"\\ude00\"}".to_vec()
        );
    }

    #[test]
    fn blank_lines_are_javascript_blank() {
        assert!(js_blank(" \t\r\u{a0}\u{feff}"));
        assert!(!js_blank(" x "));
        assert!(!js_blank("\u{85}"));
    }

    #[test]
    fn meta_names_the_browser() {
        assert_eq!(
            meta_line("/usr/lib/zen \"b\"/zen"),
            b"{\"t\":\"meta\",\"exe\":\"/usr/lib/zen \\\"b\\\"/zen\"}\n".to_vec()
        );
    }
}
