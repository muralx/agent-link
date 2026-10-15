import { spawn } from 'node:child_process';
import { mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubApiError, HubClient } from './hub-client.ts';

/**
 * LOCK_STALE_MS is the age after which a leftover hub.lock is considered
 * abandoned (10 s).
 */
export const LOCK_STALE_MS = 10_000;

/** SpawnHubOptions tells spawnHub where the hub must listen and write. */
export interface SpawnHubOptions {
  url: string;
  dataDir: string;
  logPath: string;
}

/**
 * EnsureHubOptions configures ensureHub; spawnHub, fetchImpl, timeoutMs and
 * pollMs are injectable for tests.
 */
export interface EnsureHubOptions {
  url: string;
  dataDir: string;
  spawnHub?: (options: SpawnHubOptions) => void;
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * isLoopback reports whether a URL points at the local host (127.0.0.1,
 * localhost or ::1).
 */
export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * spawnHubProcess starts agent-linkd detached with its output appended to
 * logPath, pointing it at dataDir and the host and port of url, and unrefs it
 * so the edge can exit independently.
 */
export function spawnHubProcess(options: SpawnHubOptions): void {
  const bin = fileURLToPath(import.meta.resolve('@agent-link/hub/bin'));
  const target = new URL(options.url);
  mkdirSync(options.dataDir, { recursive: true });
  const log = openSync(options.logPath, 'a');
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', bin], {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      AGENT_LINK_DATA_DIR: options.dataDir,
      AGENT_LINK_PORT: target.port || '80',
      AGENT_LINK_HOST: target.hostname,
    },
  });
  child.unref();
}

/** healthy returns whether the hub's health endpoint answers. */
async function healthy(client: HubClient): Promise<boolean> {
  try {
    await client.health();
    return true;
  } catch {
    return false;
  }
}

/**
 * acquireLock creates the lock file exclusively, first removing one older than
 * LOCK_STALE_MS; returns whether this caller owns it.
 */
function acquireLock(lockPath: string): boolean {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > LOCK_STALE_MS) rmSync(lockPath, { force: true });
  } catch {
    // no lock file
  }
  try {
    openSync(lockPath, 'wx');
    return true;
  } catch {
    return false;
  }
}

/**
 * ensureHub makes sure a hub answers at url: returns at once if health
 * succeeds; otherwise, for a loopback URL, takes the hub.lock file in dataDir
 * (stale after 10 s), spawns the hub if it won the lock, and polls health every
 * pollMs up to timeoutMs. Throws hub_unavailable for a non-loopback URL or when
 * the hub never comes up.
 */
export async function ensureHub(options: EnsureHubOptions): Promise<void> {
  const client = new HubClient(options.url, options.fetchImpl);
  if (await healthy(client)) return;
  if (!isLoopback(options.url)) {
    throw new HubApiError(
      'hub_unavailable',
      `the agent-link hub at ${options.url} is not reachable`,
      {
        hint: 'a remote hub must be started on its own host',
      },
    );
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollMs = options.pollMs ?? 100;
  const spawnHub = options.spawnHub ?? spawnHubProcess;
  mkdirSync(options.dataDir, { recursive: true });
  const lockPath = join(options.dataDir, 'hub.lock');
  const owner = acquireLock(lockPath);
  try {
    if (owner)
      spawnHub({
        url: options.url,
        dataDir: options.dataDir,
        logPath: join(options.dataDir, 'hub.log'),
      });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await healthy(client)) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new HubApiError(
      'hub_unavailable',
      `the agent-link hub did not come up at ${options.url} within ${timeoutMs} ms`,
      {
        hint: `see ${join(options.dataDir, 'hub.log')}`,
      },
    );
  } finally {
    if (owner) rmSync(lockPath, { force: true });
  }
}
