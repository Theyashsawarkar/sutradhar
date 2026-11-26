// The daemon's runtime directory, its lock and the sockets systemd hands it.
// The rules follow pranali's protocol (pranali/docs/PROTOCOL.md): a private
// directory (ours, 0700), sockets taken from systemd when it activated us,
// and never unlinking a socket some other process listens on.

import { linkSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';

/** sun_path holds 108 bytes, the last one a NUL. */
const MAX_SOCKET_PATH = 107;

/**
 * Makes sure `dir` is ours alone: a directory (not a link), owned by this
 * user, no group or other permissions. Creates it (0700) when `create` and
 * it's missing. mkdir's mode doesn't apply to a directory that already exists,
 * so this always checks after.
 */
export function privateDir(dir: string, create = true) {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let st;
  try { st = lstatSync(dir); } catch { throw new Error(`${dir} does not exist`); }
  const uid = process.getuid?.();
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory; refusing to use it`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} belongs to uid ${st.uid}, not you (${uid}); refusing to use it`);
  if (st.mode & 0o077) throw new Error(`${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}); chmod 700 it`);
}

export function checkSocketPath(p: string) {
  if (Buffer.byteLength(p) > MAX_SOCKET_PATH) throw new Error(`socket path too long for a unix socket (${Buffer.byteLength(p)} > ${MAX_SOCKET_PATH} bytes): ${p}`);
}

// ------------------------------------------------------------------ the lock
// One daemon per runtime directory. The lock file holds the owner's pid; it is
// created by link(2), which is atomic and fails when the file exists. A lock
// whose owner died is broken under a second lock (`.break`), so two daemons
// starting at once can't both decide it's stale and remove each other's.

function daemonAlive(pid: number) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return argv.includes('daemon') && argv.some((a) => /sutradhar/.test(a));
  } catch { return true; } // no /proc: trust kill(0)
}

function readPid(path: string) { try { return +readFileSync(path, 'utf8').trim() || 0; } catch { return -1; } }

/** Takes the lock, or returns the pid of the daemon holding it. */
export function acquireLock(path: string): { ok: true; release: () => void } | { ok: false; pid: number } {
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        linkSync(tmp, path);
        return { ok: true, release: () => { if (readPid(path) === process.pid) try { unlinkSync(path); } catch { /* */ } } };
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const pid = readPid(path);
      if (pid === -1) continue; // vanished between link and read: try again
      if (daemonAlive(pid)) return { ok: false, pid };
      // Stale: break it, holding the breaker.
      const brk = `${path}.break`;
      try { linkSync(tmp, brk); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Someone else is breaking it (or died doing so, long ago).
        try { if (Date.now() - statSync(brk).mtimeMs > 5000) unlinkSync(brk); } catch { /* */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      try { if (readPid(path) === pid) unlinkSync(path); } catch { /* */ } finally { try { unlinkSync(brk); } catch { /* */ } }
    }
    throw new Error(`could not take the lock ${path}`);
  } finally { try { unlinkSync(tmp); } catch { /* */ } }
}

// ------------------------------------------------------------------ sockets

/**
 * What is at `path`, where a daemon wants to bind: nothing ('none'), a
 * listening socket ('live': a daemon, or systemd's socket unit), a socket
 * that refuses connections ('dead': a crashed daemon's, safe to remove), or
 * something else ('other': left alone). /proc/net/unix answers 'live' first
 * without connecting (which would make systemd start the service); only a
 * refused connection makes it 'dead'.
 */
export async function leftover(path: string): Promise<'none' | 'live' | 'dead' | 'other'> {
  let st;
  try { st = lstatSync(path); } catch { return 'none'; }
  if (!st.isSocket()) return 'other';
  try {
    const table = readFileSync('/proc/net/unix', 'utf8');
    for (const line of table.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      // Num RefCount Protocol Flags Type St Inode Path; flag 0x10000 = listening.
      if (f.length >= 8 && f.slice(7).join(' ') === path && (parseInt(f[3], 16) & 0x10000)) return 'live';
    }
  } catch { /* not Linux: the connection decides */ }
  return new Promise((res) => {
    const c = createConnection(path);
    c.on('connect', () => { c.destroy(); res('live'); });
    c.on('error', (e: NodeJS.ErrnoException) => res(e.code === 'ECONNREFUSED' ? 'dead' : e.code === 'ENOENT' ? 'none' : 'other'));
  });
}

/**
 * The listeners systemd passed (socket activation), by role. Units:
 * sutradhar.socket (the main socket) and sutradhar-mcp.socket (mcp.sock).
 * A single unnamed fd is mcp.sock, as the protocol says.
 */
export function activatedFds(env = process.env, pid = process.pid): { main?: number; mcp?: number } {
  const n = Number(env.LISTEN_FDS);
  const forUs = Number(env.LISTEN_PID) === pid && n > 0;
  const names = (env.LISTEN_FDNAMES ?? '').split(':');
  // Children (notify-send, ffmpeg…) must not think they were activated.
  delete env.LISTEN_FDS; delete env.LISTEN_PID; delete env.LISTEN_FDNAMES;
  if (!forUs) return {};
  const out: { main?: number; mcp?: number } = {};
  for (let i = 0; i < n; i++) {
    const name = names[i] ?? '';
    if (name === 'sutradhar.socket' || name === 'main') out.main = 3 + i;
    else if (name === 'sutradhar-mcp.socket' || name === 'mcp' || n === 1) out.mcp = 3 + i;
  }
  return out;
}
