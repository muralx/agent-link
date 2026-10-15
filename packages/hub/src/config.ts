import { homedir } from 'node:os';
import { join } from 'node:path';

/** DEFAULT_PORT is the hub's default TCP port (8790). */
export const DEFAULT_PORT = 8790;
/** DEFAULT_HOST is the hub's default bind address, loopback only. */
export const DEFAULT_HOST = '127.0.0.1';

/**
 * HubConfig is the resolved hub configuration: paths under the data directory,
 * bind host and port, and the guard switch.
 */
export interface HubConfig {
  dataDir: string;
  dbPath: string;
  hubJsonPath: string;
  logPath: string;
  port: number;
  host: string;
  /** guard is false when AGENT_LINK_GUARD=off disabled the automatic rules. */
  guard: boolean;
}

/**
 * Env is a process.env-shaped record, passed explicitly so tests can control
 * it.
 */
export type Env = Record<string, string | undefined>;

/**
 * defaultDataDir resolves the agent-link data directory from the environment
 * with the XDG fallback chain; shared with the edge so both agree on where
 * hub.json lives.
 */
export function defaultDataDir(env: Env): string {
  if (env['AGENT_LINK_DATA_DIR']) return env['AGENT_LINK_DATA_DIR'];
  const xdg = env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(xdg, 'agent-link');
}

/**
 * loadConfig derives the hub's runtime configuration from an environment: data
 * directory (AGENT_LINK_DATA_DIR, else $XDG_DATA_HOME/agent-link, else
 * ~/.local/share/agent-link), the database, hub.json and log paths inside it,
 * the port (AGENT_LINK_PORT, default 8790; 0 picks a free port), bind host
 * (AGENT_LINK_HOST, default 127.0.0.1) and whether the guard's automatic rules
 * run (AGENT_LINK_GUARD=off disables them).
 */
export function loadConfig(env: Env = process.env): HubConfig {
  const dataDir = defaultDataDir(env);
  const parsedPort = Number.parseInt(env['AGENT_LINK_PORT'] ?? '', 10);
  return {
    dataDir,
    dbPath: join(dataDir, 'agent-link.db'),
    hubJsonPath: join(dataDir, 'hub.json'),
    logPath: join(dataDir, 'hub.log'),
    port: Number.isNaN(parsedPort) ? DEFAULT_PORT : parsedPort,
    host: env['AGENT_LINK_HOST'] ?? DEFAULT_HOST,
    guard: env['AGENT_LINK_GUARD'] !== 'off',
  };
}
