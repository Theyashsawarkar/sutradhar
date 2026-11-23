import { homedir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const home = env.HOME || homedir();
const runtime = env.XDG_RUNTIME_DIR || `/tmp/sutradhar-${process.getuid?.() ?? 'user'}`;

export const paths = {
  home,
  socket: env.SUTRADHAR_SOCKET || join(runtime, 'sutradhar', 'sock'),
  config: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'sutradhar'),
  state: join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'sutradhar'),
  data: join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'sutradhar'),
  downloads: join(home, 'Downloads', 'sutradhar'),
};

export const configFile = () => join(paths.config, 'config.toml');
export const logFile = () => join(paths.state, 'log.jsonl');
