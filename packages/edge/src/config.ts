import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultDataDir, type Env } from '@agent-link/hub';

/**
 * DEFAULT_HUB_URL is where the edge looks for a hub when nothing else is
 * configured (http://127.0.0.1:8790).
 */
export const DEFAULT_HUB_URL = 'http://127.0.0.1:8790';
/** WORKSPACE_FILE is the repository marker file name, .agent-link.json. */
export const WORKSPACE_FILE = '.agent-link.json';

/**
 * readJson parses a JSON object file, returning undefined when the file is
 * missing, unreadable, malformed or not an object.
 */
function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * resolveWorkspace returns the workspace for a session: AGENT_LINK_WORKSPACE
 * when set, else the workspace field of the nearest .agent-link.json found
 * walking up from cwd (unreadable or malformed files are skipped), else
 * undefined.
 */
export function resolveWorkspace(cwd: string, env: Env = process.env): string | undefined {
  if (env['AGENT_LINK_WORKSPACE']) return env['AGENT_LINK_WORKSPACE'];
  let dir = cwd;
  for (;;) {
    const config = readJson(join(dir, WORKSPACE_FILE));
    if (typeof config?.['workspace'] === 'string') return config['workspace'];
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * configDir is $XDG_CONFIG_HOME/agent-link (default ~/.config/agent-link),
 * where the optional config.json lives.
 */
export function configDir(env: Env = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(xdg, 'agent-link');
}

/**
 * resolveHubUrl returns the hub base URL without a trailing slash, in order of
 * precedence: AGENT_LINK_HUB, the hub field of
 * $XDG_CONFIG_HOME/agent-link/config.json, the url recorded in hub.json in the
 * data directory, then DEFAULT_HUB_URL.
 */
export function resolveHubUrl(env: Env = process.env): string {
  const fromEnv = env['AGENT_LINK_HUB'];
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const config = readJson(join(configDir(env), 'config.json'));
  if (typeof config?.['hub'] === 'string') return config['hub'].replace(/\/+$/, '');
  const hubJson = readJson(join(defaultDataDir(env), 'hub.json'));
  if (typeof hubJson?.['url'] === 'string') return hubJson['url'].replace(/\/+$/, '');
  return DEFAULT_HUB_URL;
}
