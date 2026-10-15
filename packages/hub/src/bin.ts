#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { createHub } from './server.ts';
import { HUB_VERSION } from './version.ts';

/**
 * main runs agent-linkd: loads config, creates the data directory, starts the
 * hub (with the guard's automatic rules off when AGENT_LINK_GUARD=off), writes
 * hub.json (url, pid, version, started_at), prints the URL as the first stdout
 * line for launchers to read, and on SIGTERM or SIGINT closes the hub, removes
 * hub.json and exits 0.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const hub = createHub({
    dbPath: config.dbPath,
    port: config.port,
    host: config.host,
    ...(config.guard ? {} : { guard: false as const }),
  });
  const url = await hub.listen();
  writeFileSync(
    config.hubJsonPath,
    JSON.stringify(
      { url, pid: process.pid, version: HUB_VERSION, started_at: new Date().toISOString() },
      null,
      2,
    ),
  );
  process.stdout.write(`${url}\n`);
  process.stderr.write(`agent-linkd ${HUB_VERSION} listening on ${url} (db ${config.dbPath})\n`);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    process.stderr.write(`agent-linkd: ${signal}, shutting down\n`);
    void hub.close().finally(() => {
      rmSync(config.hubJsonPath, { force: true });
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `agent-linkd failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
