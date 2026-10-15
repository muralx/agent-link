#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const binDir = process.env['AGENT_LINK_BIN_DIR'] ?? join(homedir(), '.local', 'bin');
/**
 * bins maps each command name to install to the absolute path of the source
 * entry point it must symlink to: `agent-linkd` to the hub's bin.ts and
 * `agent-link-edge` to the edge's bin.ts, both resolved from the repository
 * root.
 *
 * The script runs this table top to bottom: it makes each target executable
 * (mode 0755), then creates or repoints the link under binDir, refusing to
 * replace anything there that is not a symlink. Adding an entry is how a new
 * binary gets installed by this script.
 */
const bins: Record<string, string> = {
  'agent-linkd': join(root, 'packages', 'hub', 'src', 'bin.ts'),
  'agent-link-edge': join(root, 'packages', 'edge', 'src', 'bin.ts'),
};

mkdirSync(binDir, { recursive: true });
for (const [name, target] of Object.entries(bins)) {
  chmodSync(target, 0o755);
  const link = join(binDir, name);
  if (existsSync(link) || isDanglingSymlink(link)) {
    if (!lstatSync(link).isSymbolicLink()) {
      throw new Error(`${link} exists and is not a symlink; remove it first`);
    }
    if (readlinkSync(link) === target) {
      process.stdout.write(`${link} already points at ${target}\n`);
      continue;
    }
    rmSync(link);
  }
  symlinkSync(target, link);
  process.stdout.write(`${link} -> ${target}\n`);
}
if (!(process.env['PATH'] ?? '').split(':').includes(binDir)) {
  process.stderr.write(`warning: ${binDir} is not on PATH\n`);
}

/**
 * isDanglingSymlink reports whether path is a symlink even when its target no
 * longer exists.
 */
function isDanglingSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
