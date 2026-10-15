import type { HubEvent } from '@agent-link/protocol';

/** EventListener receives one HubEvent. */
export type EventListener = (event: HubEvent) => void;

/**
 * EventBus fans hub events out to in-process listeners keyed by recipient agent
 * id; the SSE route and the await long poll subscribe, the routes that create
 * messages and change presence publish. Delivery is synchronous and
 * best-effort: nothing is buffered for agents without a listener, the store is
 * the source of truth.
 */
export class EventBus {
  readonly #listeners = new Map<string, Set<EventListener>>();

  /**
   * subscribe adds a listener for one agent and returns the function that
   * removes it.
   */
  subscribe(agentId: string, listener: EventListener): () => void {
    let set = this.#listeners.get(agentId);
    if (!set) {
      set = new Set();
      this.#listeners.set(agentId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(agentId);
    };
  }

  /**
   * publish delivers the event to every current listener of the agent,
   * synchronously; listeners that unsubscribe during delivery are still called
   * for this event.
   */
  publish(agentId: string, event: HubEvent): void {
    const set = this.#listeners.get(agentId);
    if (!set) return;
    for (const listener of [...set]) listener(event);
  }

  /** publishAll publishes the same event to each agent id. */
  publishAll(agentIds: Iterable<string>, event: HubEvent): void {
    for (const id of agentIds) this.publish(id, event);
  }

  /**
   * waitFor resolves with the first event published to the agent, or undefined
   * after timeoutMs or when signal aborts; its temporary listener is always
   * removed.
   */
  waitFor(agentId: string, timeoutMs: number, signal?: AbortSignal): Promise<HubEvent | undefined> {
    return new Promise((resolve) => {
      const finish = (value: HubEvent | undefined): void => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish(undefined);
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      const off = this.subscribe(agentId, (event) => finish(event));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * listenerCount returns how many listeners an agent currently has (for tests
   * and diagnostics).
   */
  listenerCount(agentId: string): number {
    return this.#listeners.get(agentId)?.size ?? 0;
  }
}
