//! `sutradhar mcp`, small: joins the agent's stdio to the daemon's MCP socket.
//!
//! The daemon runs the MCP server itself, one session per connection to
//! `mcp.sock` (packages/daemon/src/daemon.ts). This pipe sends one preamble
//! line, `{"name": "<agent>"}`, then copies bytes both ways until either side
//! closes. With no daemon it starts one, as `sutradhar.mjs`'s connectOrStart
//! does; when none can be reached (or a daemon too old to have mcp.sock is
//! running) it becomes the old `node sutradhar.mjs mcp`, so nothing breaks.

use std::env;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::Duration;

/// `env.X || default`, as paths.ts reads it: an empty variable counts as unset.
fn var(get: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    get(key).filter(|v| !v.is_empty())
}

/// The daemon's agent socket and its MCP socket, found the way paths.ts finds them.
fn sockets(get: &dyn Fn(&str) -> Option<String>, uid: u32) -> (PathBuf, PathBuf) {
    let main = var(get, "SUTRADHAR_SOCKET").map(PathBuf::from).unwrap_or_else(|| {
        let runtime = var(get, "XDG_RUNTIME_DIR").unwrap_or_else(|| format!("/tmp/sutradhar-{uid}"));
        Path::new(&runtime).join("sutradhar").join("sock")
    });
    let mcp = var(get, "SUTRADHAR_MCP_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| main.parent().unwrap_or(Path::new("/")).join("mcp.sock"));
    (main, mcp)
}

/// The agent's name: --name, else $SUTRADHAR_AGENT, else guessed from its environment (mcp.ts agentName).
fn agent_name(args: &[String], get: &dyn Fn(&str) -> Option<String>) -> String {
    if let Some(i) = args.iter().position(|a| a == "--name")
        && let Some(n) = args.get(i + 1).filter(|n| !n.is_empty())
    {
        return n.clone();
    }
    if let Some(n) = var(get, "SUTRADHAR_AGENT") {
        return n;
    }
    if var(get, "CLAUDECODE").is_some() {
        "claude".into()
    } else if var(get, "CODEX_HOME").is_some() {
        "codex".into()
    } else {
        "agent".into()
    }
}

/// A JSON string literal.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn preamble(name: &str) -> String {
    format!("{{\"name\":{}}}\n", json_string(name))
}

/// dist/sutradhar.mjs, beside this binary (build.mjs puts both in dist/).
fn bundle() -> PathBuf {
    let exe = env::current_exe().unwrap_or_default();
    exe.parent().unwrap_or(Path::new(".")).join("sutradhar.mjs")
}

unsafe extern "C" {
    fn setsid() -> i32;
}

/// Starts a daemon in the background, as connectOrStart does (`node sutradhar.mjs daemon`, detached).
fn start_daemon() {
    let mut cmd = Command::new("node");
    cmd.arg(bundle())
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches no memory.
    unsafe {
        cmd.pre_exec(|| {
            setsid();
            Ok(())
        });
    }
    // Reap it if it exits early (another daemon won the race); a running one outlives us.
    if let Ok(mut child) = cmd.spawn() {
        thread::spawn(move || child.wait());
    }
}

/// The MCP socket, starting a daemon when none answers. None: fall back to the old in-process server.
fn connect(main: &Path, mcp: &Path) -> Option<UnixStream> {
    if let Ok(s) = UnixStream::connect(mcp) {
        return Some(s);
    }
    // A daemon is up but has no mcp.sock (one from before it had one): don't wait for it.
    if UnixStream::connect(main).is_ok() {
        return None;
    }
    start_daemon();
    for _ in 0..30 {
        thread::sleep(Duration::from_millis(100));
        if let Ok(s) = UnixStream::connect(mcp) {
            return Some(s);
        }
    }
    None
}

/// Becomes `node sutradhar.mjs mcp ARGS` (only returns if that can't start).
fn fallback(args: &[String]) -> ! {
    let mut all: Vec<OsString> = vec![bundle().into(), "mcp".into()];
    all.extend(args.iter().map(OsString::from));
    let err = Command::new("node").args(all).exec();
    eprintln!(
        "sutradhar-mcp: no daemon to reach, and could not run node {}: {err}",
        bundle().display()
    );
    process::exit(1);
}

/// Copies until EOF or an error; flushes after every chunk (each ends a message, or part of one).
fn pump(mut from: impl Read, mut to: impl Write) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                if to.write_all(&buf[..n]).and_then(|_| to.flush()).is_err() {
                    return;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let get = |k: &str| env::var(k).ok();
    let uid = std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(0);
    let (main_sock, mcp_sock) = sockets(&get, uid);
    let Some(mut sock) = connect(&main_sock, &mcp_sock) else {
        fallback(&args)
    };
    if sock.write_all(preamble(&agent_name(&args, &get)).as_bytes()).is_err() {
        fallback(&args);
    }
    let reader = sock.try_clone().unwrap_or_else(|_| fallback(&args));
    // Daemon → agent. When the daemon closes, the session is over.
    thread::spawn(move || {
        pump(reader, io::stdout().lock());
        process::exit(0);
    });
    // Agent → daemon. When the agent closes stdin, so do we.
    pump(io::stdin().lock(), &sock);
    let _ = sock.shutdown(Shutdown::Both);
    process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn sockets_follow_paths_ts() {
        let e = env_of(&[("XDG_RUNTIME_DIR", "/run/user/1000")]);
        assert_eq!(
            sockets(&e, 1000),
            (
                "/run/user/1000/sutradhar/sock".into(),
                "/run/user/1000/sutradhar/mcp.sock".into()
            )
        );
        let e = env_of(&[("XDG_RUNTIME_DIR", "")]);
        assert_eq!(sockets(&e, 42).1, PathBuf::from("/tmp/sutradhar-42/sutradhar/mcp.sock"));
        let e = env_of(&[("SUTRADHAR_SOCKET", "/t/x/sutradhar.sock")]);
        assert_eq!(sockets(&e, 1).1, PathBuf::from("/t/x/mcp.sock"));
        let e = env_of(&[
            ("SUTRADHAR_SOCKET", "/t/x/sutradhar.sock"),
            ("SUTRADHAR_MCP_SOCKET", "/m.sock"),
        ]);
        assert_eq!(sockets(&e, 1).1, PathBuf::from("/m.sock"));
    }

    #[test]
    fn names_follow_mcp_ts() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            agent_name(&a(&["--name", "w1"]), &env_of(&[("SUTRADHAR_AGENT", "x")])),
            "w1"
        );
        assert_eq!(agent_name(&a(&["--name"]), &env_of(&[("SUTRADHAR_AGENT", "x")])), "x");
        assert_eq!(
            agent_name(&[], &env_of(&[("CLAUDECODE", "1"), ("CODEX_HOME", "/c")])),
            "claude"
        );
        assert_eq!(agent_name(&[], &env_of(&[("CODEX_HOME", "/c")])), "codex");
        assert_eq!(agent_name(&[], &env_of(&[("CLAUDECODE", "")])), "agent");
    }

    #[test]
    fn preamble_is_one_json_line() {
        assert_eq!(preamble("claude"), "{\"name\":\"claude\"}\n");
        assert_eq!(preamble("a\"b\\c\nd\u{1}é"), "{\"name\":\"a\\\"b\\\\c\\nd\\u0001é\"}\n");
    }
}
