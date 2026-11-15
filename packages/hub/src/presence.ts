/**
 * DEFAULT_GRACE_MS is the reconnect grace after an SSE stream drops before the
 * agent goes offline (30 s).
 */
export const DEFAULT_GRACE_MS = 30_000;

/**
 * PresenceTracker turns SSE stream lifecycles into presence: an agent is
 * reported expired through the onExpired callback once graceMs (default
 * DEFAULT_GRACE_MS) passes with no open stream.
 *
 * It counts open streams per agent. The last stream closing (disconnected) or
 * the hub starting an online agent that has no stream (expect) starts the grace
 * timer; connected cancels a pending expiry, so a reconnect within the grace
 * keeps the agent online. isConnected tells whether an edge currently holds a
 * stream, so a session end can leave a live window alone. forget drops an
 * agent's state on unregister or re-registration, and close cancels all timers
 * at shutdown. Timers are unref'd and never keep the process alive. State is in
 * memory only and single-threaded.
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
   * disconnected records one closed stream for the agent and, when it was the
   * last, starts the grace timer that reports the agent expired after graceMs.
   *
   * While other streams remain open it only decrements the count. An agent with
   * no recorded streams is treated as having just lost its last one, so the
   * grace still starts. A later connected call within the grace cancels the
   * expiry.
   */
  disconnected(agentId: string): void {
    const remaining = (this.#streams.get(agentId) ?? 1) - 1;
    if (remaining > 0) {
      this.#streams.set(agentId, remaining);
      return;
    }
    this.#streams.delete(agentId);
    this.#schedule(agentId);
  }

  /**
   * expect starts the grace for an agent that is online with no stream open,
   * as every online agent is when the hub starts: it expires unless an edge
   * connects first. A no-op when a stream is open or an expiry is pending.
   */
  expect(agentId: string): void {
    if (this.isConnected(agentId) || this.#timers.has(agentId)) return;
    this.#schedule(agentId);
  }

  /** #schedule reports the agent expired after the grace period. */
  #schedule(agentId: string): void {
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
