import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Env is the subset of process.env the window lookup reads. */
type Env = Record<string, string | undefined>;

/**
 * WindowOptions configures currentWindowId: the /proc root, the starting pid,
 * the platform and the environment; all injectable for tests.
 */
export interface WindowOptions {
  /** procRoot replaces /proc (tests build a fake tree). */
  procRoot?: string | undefined;
  /** pid is where the parent walk starts; the current process by default. */
  pid?: number | undefined;
  /** platform overrides process.platform; only linux is supported. */
  platform?: string | undefined;
  /** env supplies AGENT_LINK_WINDOW, AGENT_LINK_CHANNEL and CLAUDE_PID; process.env by default. */
  env?: Env | undefined;
}

/** MAX_DEPTH bounds the parent walk so a cycle or a huge tree cannot hang the caller. */
const MAX_DEPTH = 16;

/**
 * ProcStat is the part of /proc/<pid>/stat the walk uses: the command name, the
 * parent pid and the process start time in clock ticks since boot.
 */
interface ProcStat {
  /**
   * comm is the process command name as /proc reports it, without parentheses.
   */
  comm: string;
  /** ppid is the parent process id. */
  ppid: number;
  /**
   * starttime is the process start time in clock ticks since boot (stat field
   * 22), kept as text.
   */
  starttime: string;
}

/**
 * readStat parses /proc/<pid>/stat, tolerating spaces and parentheses inside
 * the command name; undefined when the process is gone or unreadable.
 */
function readStat(procRoot: string, pid: number): ProcStat | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
  } catch {
    return undefined;
  }
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const comm = raw.slice(open + 1, close);
  const rest = raw.slice(close + 2).split(' ');
  // rest[0] is the state (field 3); ppid is field 4 and starttime field 22.
  const ppid = Number(rest[1]);
  const starttime = rest[19];
  if (!Number.isFinite(ppid) || starttime === undefined) return undefined;
  return { comm, ppid, starttime };
}

/**
 * isClaude reports whether a process command name is the Claude Code CLI.
 */
function isClaude(comm: string): boolean {
  return comm === 'claude' || comm.startsWith('claude-');
}

/**
 * currentWindowId identifies the Claude Code window (the claude process) this
 * process runs under, as "<boot id prefix>-<pid>-<start time>", stable for the
 * window's lifetime and across session switches inside it, and unique across
 * pid reuse and reboots. It locates the claude ancestor with findClaude (parent
 * walk in /proc from the current pid, CLAUDE_PID fallback). AGENT_LINK_WINDOW,
 * when set, is returned as is (test harnesses that spawn several edges under
 * one Claude process give each its own). Returns undefined outside Linux or
 * when no claude ancestor exists.
 */
export function currentWindowId(options: WindowOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const override = env['AGENT_LINK_WINDOW'];
  if (override) return override;
  const found = findClaude(options);
  if (!found) return undefined;
  const procRoot = options.procRoot ?? '/proc';
  let bootId: string;
  try {
    bootId = readFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim();
  } catch {
    bootId = 'noboot';
  }
  return `${bootId.slice(0, 8)}-${found.pid}-${found.stat.starttime}`;
}

/** CHANNELS_FLAG is the Claude Code flag that enables channels for a server. */
const CHANNELS_FLAG = '--dangerously-load-development-channels';

/**
 * channelEnabled reports whether the Claude Code window this process runs under
 * was started with the channels flag naming agent-link
 * (--dangerously-load-development-channels plugin:agent-link@<marketplace>, or
 * server:agent-link), which is the only way channel notifications reach the
 * model: without it they are silently dropped. It reads the claude ancestor's
 * /proc cmdline (same walk and CLAUDE_PID fallback as currentWindowId).
 * AGENT_LINK_CHANNEL=on|off overrides the lookup (harnesses without a claude
 * ancestor). Returns undefined when it cannot tell (no claude ancestor, not
 * Linux); callers treat unknown as enabled.
 */
export function channelEnabled(options: WindowOptions = {}): boolean | undefined {
  const env = options.env ?? process.env;
  const override = env['AGENT_LINK_CHANNEL']?.toLowerCase();
  if (override !== undefined && override !== '') {
    return !['off', '0', 'false', 'no'].includes(override);
  }
  const found = findClaude(options);
  if (!found) return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(options.procRoot ?? '/proc', String(found.pid), 'cmdline'), 'utf8');
  } catch {
    return undefined;
  }
  const args = raw.split('\0').filter((a) => a !== '');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === CHANNELS_FLAG) value = args[i + 1];
    else if (arg.startsWith(`${CHANNELS_FLAG}=`)) value = arg.slice(CHANNELS_FLAG.length + 1);
    if (value === undefined) continue;
    const names = value.split(',').map((v) => v.trim().replace(/^(plugin|server):/, ''));
    if (names.some((n) => n === 'agent-link' || n.startsWith('agent-link@'))) return true;
  }
  return false;
}

/**
 * findClaude walks the parent chain in /proc from options.pid (the current
 * process by default) to the nearest claude process and returns its pid and
 * stat, falling back to CLAUDE_PID; undefined outside Linux or when there is
 * none.
 */
function findClaude(options: WindowOptions): { pid: number; stat: ProcStat } | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return undefined;
  const procRoot = options.procRoot ?? '/proc';
  let pid = options.pid ?? process.pid;
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth++) {
    const stat = readStat(procRoot, pid);
    if (!stat) break;
    if (isClaude(stat.comm)) return { pid, stat };
    pid = stat.ppid;
  }
  const fromEnv = Number(env['CLAUDE_PID']);
  if (Number.isFinite(fromEnv) && fromEnv > 1) {
    const stat = readStat(procRoot, fromEnv);
    if (stat) return { pid: fromEnv, stat };
  }
  return undefined;
}
