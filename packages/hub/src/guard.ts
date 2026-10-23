import type { Agent, GuardRule, Incident } from '@agent-link/protocol';
import type { HubDeps } from './deps.ts';
import { HubError } from './store/errors.ts';
import type { QueuedMessage } from './store/messages.ts';
import type { SendAttempt } from './store/guard.ts';

/**
 * auditKey is the event bus key the audit feed's long poll listens on: every
 * message stored in the workspace is published to it.
 */
export function auditKey(workspace: string): string {
  return `audit:${workspace}`;
}

/**
 * publishMessage fans a stored message out as a message event to its
 * recipients, each woken by it, and to the workspace's audit feed.
 */
export function publishMessage(
  deps: HubDeps,
  workspace: string,
  recipientIds: string[],
  queued: QueuedMessage,
): void {
  const event = {
    type: 'message' as const,
    message: queued.message,
    subject: queued.subject,
    participants: queued.participants,
    kind: queued.kind,
    starter: queued.starter,
    wake: true,
  };
  for (const id of recipientIds) deps.bus.publish(id, event);
  deps.bus.publish(auditKey(workspace), event);
}

/**
 * notifyHumans sends a notice from the workspace's system agent to every
 * identified human of the workspace, online or not, except exceptId; with no
 * human to tell it does nothing (the incident log still has the record).
 */
export function notifyHumans(
  deps: HubDeps,
  workspace: string,
  subject: string,
  body: string,
  exceptId?: string,
): void {
  const recipientIds = deps.stores.agents.humanIds(workspace, exceptId);
  const queued = deps.stores.messages.post({
    workspace,
    fromId: deps.stores.agents.systemAgent(workspace),
    recipientIds,
    subject,
    body,
  });
  if (queued) publishMessage(deps, workspace, recipientIds, queued);
}

/**
 * quarantine blocks the target's sends, records the incident and tells the
 * humans how to release it. by is the human who asked, or undefined when one of
 * the hub's own rules fired. Quarantining an agent that already is only adds
 * the incident.
 */
export function quarantine(
  deps: HubDeps,
  target: Agent,
  rule: GuardRule,
  detail: string,
  by?: Agent,
): Incident {
  deps.stores.agents.setQuarantine(target.id, detail);
  const incident = deps.stores.guard.record({
    workspace: target.workspace,
    agentId: target.id,
    rule,
    action: 'quarantined',
    detail,
    byId: by?.id,
  });
  notifyHumans(
    deps,
    target.workspace,
    `guard: ${target.name} quarantined (${rule})`,
    `**${target.name}** was quarantined by ${by ? by.name : 'the guard'}: ${detail}.\n\n` +
      `Its messages are refused until a human releases it; it can still read. ` +
      `To let it send again, use the guard tool with action "release" and name "${target.name}" ` +
      `(in a relay window: "release ${target.name}"). The audit tool shows what it sent.`,
    by?.id,
  );
  return incident;
}

/**
 * release lifts the target's quarantine on a human's word, records the incident
 * and tells the other humans.
 */
export function release(deps: HubDeps, target: Agent, by: Agent, reason?: string): Incident {
  deps.stores.agents.setQuarantine(target.id, null);
  const incident = deps.stores.guard.record({
    workspace: target.workspace,
    agentId: target.id,
    rule: 'manual',
    action: 'released',
    detail: reason ?? 'released',
    byId: by.id,
  });
  notifyHumans(
    deps,
    target.workspace,
    `guard: ${target.name} released`,
    `**${target.name}** was released from quarantine by ${by.name}${reason ? `: ${reason}` : ''}.`,
    by.id,
  );
  return incident;
}

/**
 * flag records an incident that changes nothing by itself and tells the humans
 * (except exceptId): a role change, or a request for a quarantine.
 */
export function flag(
  deps: HubDeps,
  target: Agent,
  rule: GuardRule,
  action: 'flagged' | 'requested',
  detail: string,
  options: { by?: Agent; exceptId?: string; body?: string } = {},
): Incident {
  const incident = deps.stores.guard.record({
    workspace: target.workspace,
    agentId: target.id,
    rule,
    action,
    detail,
    byId: options.by?.id,
  });
  notifyHumans(
    deps,
    target.workspace,
    `guard: ${target.name} ${action} (${rule})`,
    options.body ?? `**${target.name}**: ${detail}.`,
    options.exceptId,
  );
  return incident;
}

/**
 * enforce is the guard's check on a send, called before the message is stored.
 * A quarantined sender is refused with a quarantined error. Otherwise, when the
 * automatic rules are on and the attempt breaks one, the sender is quarantined
 * (incident recorded, humans told) and this attempt is refused the same way.
 * Humans are never checked by the rules.
 */
export function enforce(deps: HubDeps, sender: Agent, attempt: SendAttempt): void {
  const hint =
    'stop sending; tell the person at your keyboard that the agent-link guard quarantined you and why. A human of the workspace can release you with the guard tool.';
  if (sender.quarantined) {
    const reason =
      deps.stores.guard.quarantined(sender.workspace).find((q) => q.name === sender.name)?.reason ??
      'no reason recorded';
    throw new HubError('quarantined', `you are quarantined: ${reason}`, { hint });
  }
  if (!deps.guardRules) return;
  const violation = deps.stores.guard.check(sender, attempt);
  if (!violation) return;
  quarantine(deps, sender, violation.rule, violation.detail);
  throw new HubError('quarantined', `you have been quarantined: ${violation.detail}`, { hint });
}
