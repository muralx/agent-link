import type { Router } from './http.ts';
import type { EventBus } from './events.ts';
import type { AgentStore } from './store/agents.ts';
import type { AuditStore } from './store/audit.ts';
import type { ConversationStore } from './store/conversations.ts';
import type { GuardStore } from './store/guard.ts';
import type { MessageStore } from './store/messages.ts';
import type { SessionStore } from './store/sessions.ts';
import type { PresenceTracker } from './presence.ts';

/** Stores groups the six store objects over the one database. */
export interface Stores {
  agents: AgentStore;
  sessions: SessionStore;
  conversations: ConversationStore;
  messages: MessageStore;
  /**
   * guard is the GuardStore: the incident log and the sending limits checked on
   * every send.
   */
  guard: GuardStore;
  /** audit is the AuditStore behind the read-only workspace audit routes. */
  audit: AuditStore;
}

/**
 * HubDeps bundles what every route module needs: the router to register on, the
 * stores, the event bus, the presence tracker, the SSE keepalive interval, the
 * set of open-stream close functions the hub calls on shutdown, and guardRules,
 * false when the guard's automatic rules are switched off (quarantines already
 * in place are still enforced).
 */
export interface HubDeps {
  router: Router;
  stores: Stores;
  bus: EventBus;
  presence: PresenceTracker;
  keepaliveMs: number;
  streams: Set<() => void>;
  /**
   * guardRules is false when the hub was created with guard: false; enforce
   * then skips the automatic rules but still refuses quarantined senders.
   */
  guardRules: boolean;
}

/**
 * announcePeer publishes a peer event for the agent to every other online
 * agent in its workspace: joined, left, or updated when a reclaim changed the
 * agent's identity (previousName is the name it had before); a no-op for
 * unknown ids.
 */
export function announcePeer(
  deps: HubDeps,
  agentId: string,
  event: 'joined' | 'left' | 'updated',
  previousName?: string,
): void {
  const agent = deps.stores.agents.byId(agentId);
  if (!agent) return;
  deps.bus.publishAll(deps.stores.agents.onlineIds(agent.workspace, agent.id), {
    type: 'peer',
    event,
    name: agent.name,
    description: agent.description,
    kind: agent.kind,
    provisional: agent.provisional,
    ...(previousName === undefined ? {} : { previous_name: previousName }),
  });
}

/**
 * takeOffline marks an online agent offline and announces peer left; a no-op
 * when the agent is unknown or already offline.
 */
export function takeOffline(deps: HubDeps, agentId: string): void {
  const agent = deps.stores.agents.byId(agentId);
  if (!agent || agent.status !== 'online') return;
  deps.stores.agents.setOffline(agentId);
  announcePeer(deps, agentId, 'left');
}
