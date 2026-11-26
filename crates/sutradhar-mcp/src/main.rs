//! `sutradhar mcp`, small: joins the agent's stdio to the daemon's MCP socket.
//!
//! The daemon runs the MCP server itself, one session per connection to
//! `mcp.sock` (packages/daemon/src/daemon.ts). This pipe sends one preamble
//! line, `{"name": "<agent>"}`, then copies JSON-RPC lines both ways. With no daemon it starts one, as `sutradhar.mjs`'s connectOrStart
//! does; when none can be reached (or a daemon too old to have mcp.sock is
//! running) it becomes the old `node sutradhar.mjs mcp`, so nothing breaks.
//!
//! When the daemon restarts mid-session, the agent never notices beyond a
//! failed call: requests the daemon had get an error ("try again"), the pipe
//! reconnects, replays the agent's `initialize` (answer swallowed) and
//! `initialized`, and sends what queued up meanwhile. It only exits when the
//! agent closes stdin.

use std::collections::VecDeque;
use std::env;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

mod jsonrpc;

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

const RESTARTED: &str = "sutradhar daemon restarted; try again";
/// Messages held while the daemon is away; past this, requests are answered with RESTARTED.
const QUEUE_MAX: usize = 64;

/// What both directions share.
struct State {
    /// The daemon's socket; None while reconnecting.
    writer: Option<Arc<UnixStream>>,
    /// Lines from the agent waiting for the daemon, with their request id.
    queue: VecDeque<(Vec<u8>, Option<String>)>,
    /// Ids of requests the daemon has and hasn't answered.
    sent: Vec<String>,
    /// The agent's handshake, replayed to a restarted daemon.
    init: Option<Vec<u8>>,
    initialized: Option<Vec<u8>>,
}

struct Shared {
    st: Mutex<State>,
    /// Signalled when the agent queues a line.
    wake: Condvar,
}

struct Target {
    main: PathBuf,
    mcp: PathBuf,
    name: String,
    /// How long one round of reconnecting lasts before waiting answers fail.
    window: Duration,
}

fn out(line: &[u8]) {
    let mut o = io::stdout().lock();
    let _ = o.write_all(line).and_then(|_| o.flush());
}

/// Agent → daemon, line by line; queued while the daemon is away. Returns at stdin EOF.
fn agent_side(sh: &Shared) {
    let mut input = BufReader::new(io::stdin().lock());
    let mut line = Vec::new();
    loop {
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) => return,
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
        if !line.ends_with(b"\n") {
            line.push(b'\n');
        }
        let m = jsonrpc::parse(&line);
        let id = m.is_request().then(|| m.id().unwrap_or_default().to_string());
        let mut st = sh.st.lock().unwrap();
        match m.method.as_deref() {
            Some("initialize") => st.init = Some(line.clone()),
            Some("notifications/initialized") => st.initialized = Some(line.clone()),
            _ => {}
        }
        if let Some(w) = st.writer.clone() {
            st.sent.extend(id);
            drop(st);
            // A failed write shows up as the socket closing, on the daemon side.
            let _ = (&*w).write_all(&line);
        } else if st.queue.len() < QUEUE_MAX {
            st.queue.push_back((line.clone(), id));
            sh.wake.notify_all();
        } else {
            drop(st);
            if let Some(id) = id {
                out(&jsonrpc::error_line(&id, RESTARTED));
            }
        }
    }
}

/// Daemon → agent, forever: when the daemon goes away, fails what it had, reconnects and carries on.
fn daemon_side(sh: &Shared, t: &Target, mut reader: BufReader<UnixStream>) {
    let mut reinit = 0u32;
    loop {
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
            let m = jsonrpc::parse(&line);
            if m.reply
                && let Some(id) = m.id()
            {
                let mut st = sh.st.lock().unwrap();
                if let Some(i) = st.sent.iter().position(|x| x == id) {
                    st.sent.remove(i);
                }
            }
            out(&line);
        }
        let lost = {
            let mut st = sh.st.lock().unwrap();
            st.writer = None;
            std::mem::take(&mut st.sent)
        };
        for id in lost {
            out(&jsonrpc::error_line(&id, RESTARTED));
        }
        reader = reconnect(sh, t, &mut reinit);
    }
}

/// Tries until a daemon takes the session back: 100 ms doubling to 2 s, for one window; then fails
/// what's queued and waits for the agent's next request to try again.
fn reconnect(sh: &Shared, t: &Target, reinit: &mut u32) -> BufReader<UnixStream> {
    // A restarting service needs a moment; start one ourselves only if none comes.
    let start_after = (t.window / 2).min(Duration::from_millis(2500));
    loop {
        let began = Instant::now();
        let mut delay = Duration::from_millis(100);
        let mut started = false;
        loop {
            if let Some(r) = resume(sh, t, reinit) {
                return r;
            }
            let now = began.elapsed();
            if now >= t.window {
                break;
            }
            if !started && now >= start_after && UnixStream::connect(&t.main).is_err() {
                start_daemon();
                started = true;
            }
            let mut nap = delay.min(t.window - now);
            if !started && now < start_after {
                nap = nap.min(start_after - now);
            }
            thread::sleep(nap);
            delay = (delay * 2).min(Duration::from_secs(2));
        }
        let mut st = sh.st.lock().unwrap();
        for (_, id) in st.queue.drain(..) {
            if let Some(id) = id {
                out(&jsonrpc::error_line(&id, RESTARTED));
            }
        }
        drop(
            sh.wake
                .wait_while(st, |s| !s.queue.iter().any(|(_, id)| id.is_some()))
                .unwrap(),
        );
    }
}

/// One attempt: connect, name the session, replay the handshake (its answer swallowed), send what
/// queued up, then hand the socket to the agent side.
fn resume(sh: &Shared, t: &Target, reinit: &mut u32) -> Option<BufReader<UnixStream>> {
    let sock = UnixStream::connect(&t.mcp).ok()?;
    let mut w = &sock;
    w.write_all(preamble(&t.name).as_bytes()).ok()?;
    let mut reader = BufReader::new(sock.try_clone().ok()?);
    let (init, initialized) = {
        let st = sh.st.lock().unwrap();
        (st.init.clone(), st.initialized.clone())
    };
    if let Some(init) = init {
        *reinit += 1;
        let id = format!("\"pipe-reinit-{reinit}\"");
        w.write_all(&jsonrpc::with_id(&init, &jsonrpc::parse(&init), &id))
            .ok()?;
        sock.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
        let mut line = Vec::new();
        loop {
            line.clear();
            if reader.read_until(b'\n', &mut line).ok()? == 0 {
                return None;
            }
            if jsonrpc::parse(&line).id() == Some(id.as_str()) {
                break;
            }
        }
        sock.set_read_timeout(None).ok()?;
        if let Some(i) = initialized {
            w.write_all(&i).ok()?;
        }
    }
    // In order, with the agent side still queueing; a failed write fails them all, through `sent`.
    let sock = Arc::new(sock);
    loop {
        let mut st = sh.st.lock().unwrap();
        let Some((line, id)) = st.queue.pop_front() else {
            st.writer = Some(sock);
            return Some(reader);
        };
        st.sent.extend(id);
        drop(st);
        let _ = (&*sock).write_all(&line);
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let get = |k: &str| env::var(k).ok();
    let uid = std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(0);
    let (main_sock, mcp_sock) = sockets(&get, uid);
    let Some(sock) = connect(&main_sock, &mcp_sock) else {
        fallback(&args)
    };
    let t = Target {
        main: main_sock,
        mcp: mcp_sock,
        name: agent_name(&args, &get),
        // For tests only: a shorter round of reconnecting.
        window: Duration::from_millis(
            var(&get, "SUTRADHAR_MCP_RECONNECT_MS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(60_000),
        ),
    };
    if (&sock).write_all(preamble(&t.name).as_bytes()).is_err() {
        fallback(&args);
    }
    let reader = BufReader::new(sock.try_clone().unwrap_or_else(|_| fallback(&args)));
    let sh = Arc::new(Shared {
        st: Mutex::new(State {
            writer: Some(Arc::new(sock)),
            queue: VecDeque::new(),
            sent: Vec::new(),
            init: None,
            initialized: None,
        }),
        wake: Condvar::new(),
    });
    let sh2 = sh.clone();
    thread::spawn(move || daemon_side(&sh2, &t, reader));
    agent_side(&sh);
    // The agent is done: so are we.
    if let Some(w) = &sh.st.lock().unwrap().writer {
        let _ = w.shutdown(Shutdown::Both);
    }
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
