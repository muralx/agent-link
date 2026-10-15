/**
 * DEFAULT_GRACE_MS is the reconnect grace after an SSE stream drops before the
 * agent goes offline (30 s).
 */
export const DEFAULT_GRACE_MS = 30_000;

/**
 * PresenceTracker turns SSE stream lifecycles into presence: an agent whose
 * last stream disconnects is reported expired after graceMs unless a stream
 * reconnects first, and isConnected tells whether an edge currently holds a
 * stream (so a session end can leave a live window alone). Timers are unref'd
 * so they never keep the process alive.
 */
export class PresenceTracker {
  readonly #graceMs: number;
  readonly #onExpired: (agentId: string) => void;
  readonly #streams = new Map<string, number>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(onExpired: (agentId: string) => void, graceMs: number = DEFAULT_GRACE_MS) {
    this.#onExpired = onExpired;
    this.#graceMs = graceMs;
  }

  /**
   * connected records one more open stream for the agent and cancels a pending
   * expiry.
   */
  connected(agentId: string): void {
    const timer = this.#timers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(agentId);
    }
    this.#streams.set(agentId, (this.#streams.get(agentId) ?? 0) + 1);
  }

  /**
   * disconnected records a closed stream; when it was the agent's last,
   * schedules the expiry callback after the grace period.
   */
  disconnected(agentId: string): void {
    const remaining = (this.#streams.get(agentId) ?? 1) - 1;
    if (remaining > 0) {
      this.#streams.set(agentId, remaining);
      return;
    }
    this.#streams.delete(agentId);
    const timer = setTimeout(() => {
      this.#timers.delete(agentId);
      this.#onExpired(agentId);
    }, this.#graceMs);
    timer.unref();
    this.#timers.set(agentId, timer);
  }

  /**
   * isConnected reports whether the agent has at least one open stream right
   * now (an edge process is alive for it).
   */
  isConnected(agentId: string): boolean {
    return (this.#streams.get(agentId) ?? 0) > 0;
  }

  /**
   * forget drops any pending expiry and stream count for the agent, used when
   * the agent is explicitly unregistered or re-registers.
   */
  forget(agentId: string): void {
    const timer = this.#timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(agentId);
    this.#streams.delete(agentId);
  }

  /** close cancels every pending expiry; call it when the hub shuts down. */
  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#streams.clear();
  }
}
