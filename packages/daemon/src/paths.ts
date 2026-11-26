import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const env = process.env;
const home = env.HOME || homedir();
const state = join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'sutradhar');
// pranali's rule (docs/PROTOCOL.md there): $XDG_RUNTIME_DIR/sutradhar, else
// ${XDG_STATE_HOME}/sutradhar/run. Never /tmp: another user could own it first.
const runtime = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'sutradhar') : join(state, 'run');

const socket = env.SUTRADHAR_SOCKET || join(runtime, 'sock');

export const paths = {
  home,
  socket,
  /** MCP sessions (what pranali connects to), beside the agent socket. */
  mcpSocket: env.SUTRADHAR_MCP_SOCKET || join(dirname(socket), 'mcp.sock'),
  /** Held by the running daemon (runtime.ts): a second one never touches the sockets. */
  lock: join(dirname(socket), 'daemon.lock'),
  config: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'sutradhar'),
  state,
  downloads: join(home, 'Downloads', 'sutradhar'),
};

export const configFile = () => join(paths.config, 'config.toml');
export const logFile = () => join(paths.state, 'log.jsonl');
