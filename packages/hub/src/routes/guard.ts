import type { IncomingMessage } from 'node:http';
import {
  GuardActionRequestSchema,
  type Agent,
  type GuardStatusResponse,
  type Incident,
} from '@agent-link/protocol';
import { requireWorkspace } from '../auth.ts';
import type { HubDeps } from '../deps.ts';
import { flag, quarantine, release } from '../guard.ts';
import { HubError } from '../store/errors.ts';

/**
 * requireRole authenticates a member of the workspace that is not quarantined
 * and is a human, or also a watcher when watchers is true; anyone else gets a
 * 403. It is how the guard and audit routes keep enforcement with humans and
 * observation with humans and watchers.
 */
export function requireRole(
  deps: HubDeps,
  req: IncomingMessage,
  workspace: string,
  watchers: boolean,
): Agent {
  const agent = requireWorkspace(deps.stores.agents, req, workspace);
  const allowed = agent.kind === 'human' || (watchers && agent.watcher);
  if (!allowed || agent.quarantined) {
    throw new HubError(
      'unauthorized',
      watchers
        ? 'only a human or a watcher of this workspace may do this'
        : 'only a human of this workspace may do this',
      { status: 403 },
    );
  }
  return agent;
}

/**
 * target resolves the agent a guard action names within the workspace, or
 * fails with peer_not_found.
 */
function target(deps: HubDeps, workspace: string, name: string): Agent {
  const agent = deps.stores.agents.findByName(workspace, name);
  if (!agent) throw new HubError('peer_not_found', `no agent named ${name} in this workspace`);
  return agent;
}

/**
 * registerGuardRoutes adds the guard's routes, all scoped to the caller's own
 * workspace. GET /v1/workspaces/:ws/guard returns the quarantined agents and
 * the recent incidents to any member. POST .../guard/quarantine and POST
 * .../guard/release act on the named agent and are for humans only; a human
 * cannot be quarantined. POST .../guard/requests lets a watcher or a human ask
 * for a quarantine: it records the request and tells the humans, nothing more.
 * Each POST answers 201 with the incident it recorded.
 */
export function registerGuardRoutes(deps: HubDeps): void {
  const { router, stores } = deps;

  router.add('GET', '/v1/workspaces/:ws/guard', ({ req, params }) => {
    const agent = requireWorkspace(stores.agents, req, params['ws'] ?? '');
    const body: GuardStatusResponse = {
      quarantined: stores.guard.quarantined(agent.workspace),
      incidents: stores.guard.incidents(agent.workspace),
    };
    return { body };
  });

  router.add('POST', '/v1/workspaces/:ws/guard/quarantine', async ({ req, params, parseJson }) => {
    const human = requireRole(deps, req, params['ws'] ?? '', false);
    const input = await parseJson(GuardActionRequestSchema);
    const agent = target(deps, human.workspace, input.name);
    if (agent.kind === 'human') {
      throw new HubError('invalid_message', 'a human cannot be quarantined');
    }
    const body: Incident = quarantine(
      deps,
      agent,
      'manual',
      input.reason ?? 'quarantined by a human',
      human,
    );
    return { status: 201, body };
  });

  router.add('POST', '/v1/workspaces/:ws/guard/release', async ({ req, params, parseJson }) => {
    const human = requireRole(deps, req, params['ws'] ?? '', false);
    const input = await parseJson(GuardActionRequestSchema);
    const agent = target(deps, human.workspace, input.name);
    if (!agent.quarantined) {
      throw new HubError('invalid_message', `${agent.name} is not quarantined`);
    }
    const body: Incident = release(deps, agent, human, input.reason);
    return { status: 201, body };
  });

  router.add('POST', '/v1/workspaces/:ws/guard/requests', async ({ req, params, parseJson }) => {
    const observer = requireRole(deps, req, params['ws'] ?? '', true);
    const input = await parseJson(GuardActionRequestSchema);
    const agent = target(deps, observer.workspace, input.name);
    const reason = input.reason ?? 'no reason given';
    const body: Incident = flag(deps, agent, 'request', 'requested', reason, {
      by: observer,
      exceptId: observer.id,
      body:
        `**${observer.name}** asks to quarantine **${agent.name}**: ${reason}.\n\n` +
        `Nothing was blocked. To quarantine it, use the guard tool with action "quarantine" and name "${agent.name}" ` +
        `(in a relay window: "quarantine ${agent.name}").`,
    });
    return { status: 201, body };
  });
}
