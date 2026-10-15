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
 * Claude session id) and the live SSE subscription. It is empty until the
 * automatic provisional registration or the register tool succeeds, and after
 * unregister.
 */
export class EdgeSession {
  #identity: Identity | undefined;
  #subscription: EventSubscription | undefined;

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
