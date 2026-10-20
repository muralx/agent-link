import type { AgentKind, RegisterResponse } from '@agent-link/protocol';
import type { EventSubscription } from './hub-client.ts';

/**
 * Identity is what the edge knows about its own agent after register, including
 * the bearer token every hub call needs and whether the registration is still
 * provisional (automatic, not yet identified by the model).
 */
export interface Identity {
  agentId: string;
  token: string;
  name: string;
  workspace: string;
  kind: AgentKind;
  /**
   * provisional is true while the registration is the edge's automatic
   * placeholder; the register tool clears it.
   */
  provisional: boolean;
  sessionId: string;
}

/**
 * EdgeSession is the edge process's only mutable state: the identity obtained
 * from register (agent id, token, name, workspace, kind, provisional flag,
 * Claude session id), the live SSE subscription, and what the await tool is
 * waiting for or recently returned, which the channel consults so a message
 * reaches the model once. It is empty until the automatic provisional
 * registration or the register tool succeeds, and after unregister.
 */
export class EdgeSession {
  #identity: Identity | undefined;
  #subscription: EventSubscription | undefined;
  /**
   * #awaits holds one entry per await call in progress, with the conversation
   * it waits on (undefined for any); beginAwait adds an entry and its returned
   * function removes it.
   */
  readonly #awaits = new Set<{ conversationId: string | undefined }>();
  /**
   * #returned holds the ids of the last 200 messages an await call returned,
   * oldest first, so a channel event that arrives after the await result is not
   * pushed again.
   */
  readonly #returned: string[] = [];

  /**
   * beginAwait records that the await tool is waiting (in one conversation, or
   * on anything when conversationId is undefined) and returns the function that
   * ends the record. While it lasts, awaited tells the channel to leave matching
   * messages to the await result instead of pushing them too.
   */
  beginAwait(conversationId: string | undefined): () => void {
    const entry = { conversationId };
    this.#awaits.add(entry);
    return () => this.#awaits.delete(entry);
  }

  /**
   * noteReturned records the ids of messages the await tool returned (the last
   * 200 are kept), so the channel does not push them again when their event
   * arrives after the await result.
   */
  noteReturned(messageIds: string[]): void {
    this.#returned.push(...messageIds);
    if (this.#returned.length > 200) this.#returned.splice(0, this.#returned.length - 200);
  }

  /**
   * awaited reports whether the await tool returns, or will return, the given
   * message: it was in a recent await result, or an active await waits on its
   * conversation or on anything.
   */
  awaited(conversationId: string, messageId: string): boolean {
    if (this.#returned.includes(messageId)) return true;
    for (const a of this.#awaits) {
      if (a.conversationId === undefined || a.conversationId === conversationId) return true;
    }
    return false;
  }

  /**
   * The identity adopted from the last successful registration, or undefined
   * when the edge is not registered.
   *
   * The returned object is the stored one, not a copy; it changes only through
   * adopt and clear.
   */
  get identity(): Identity | undefined {
    return this.#identity;
  }

  /**
   * True when the edge holds an identity, whether provisional or not.
   *
   * Equivalent to identity being defined; it says nothing about whether the SSE
   * subscription is live.
   */
  get registered(): boolean {
    return this.#identity !== undefined;
  }

  /**
   * adopt stores the identity from a successful registration (including its
   * provisional flag) and returns it.
   */
  adopt(sessionId: string, registration: RegisterResponse): Identity {
    this.#identity = {
      agentId: registration.agent.id,
      token: registration.token,
      name: registration.agent.name,
      workspace: registration.agent.workspace,
      kind: registration.agent.kind,
      provisional: registration.agent.provisional,
      sessionId,
    };
    return this.#identity;
  }

  /**
   * replaceSubscription stops the current SSE subscription, if any, and keeps
   * the new one (or none).
   */
  replaceSubscription(subscription: EventSubscription | undefined): void {
    this.#subscription?.stop();
    this.#subscription = subscription;
  }

  /** clear stops the subscription and forgets the identity. */
  clear(): void {
    this.replaceSubscription(undefined);
    this.#identity = undefined;
  }
}
