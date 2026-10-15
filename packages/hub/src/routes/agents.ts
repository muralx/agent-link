import { RegisterRequestSchema, type RegisterResponse } from '@agent-link/protocol';
import { requireAgent, requireWorkspace } from '../auth.ts';
import { announcePeer, takeOffline, type HubDeps } from '../deps.ts';
import { flag } from '../guard.ts';
import { HubError } from '../store/errors.ts';

/**
 * registerAgentRoutes adds POST /v1/agents (register or reclaim by the edge's
 * own agent_id (its bearer token must belong to it, else 401/403), by session
 * id or by window id, adopting an offline agent of the same name on an
 * identified registration; workspace from the body or the session hint else
 * workspace_required, links the session, returns token and peers), DELETE
 * /v1/agents/:id (own token only, goes offline, announces left) and GET
 * /v1/workspaces/:ws/agents (peers, only for members of that workspace).
 *
 * A registration announces peer joined, except when it reclaims an agent that
 * was already online in the same workspace: then it announces peer updated with
 * the previous name when the name or the provisional flag changed, and stays
 * silent otherwise (a plain token refresh).
 *
 * An identified registration that makes the agent a human relay or a watcher,
 * when it was not one before, is recorded as a guard incident and announced to
 * the other humans of the workspace, since both roles are self-declared.
 */
export function registerAgentRoutes(deps: HubDeps): void {
  const { router, stores } = deps;

  router.add('POST', '/v1/agents', async ({ req, parseJson }) => {
    const input = await parseJson(RegisterRequestSchema);
    if (input.agent_id) requireAgent(stores.agents, req, input.agent_id);
    const session = stores.sessions.upsert({
      session_id: input.session_id,
      cwd: input.cwd,
      window: input.window,
    });
    const workspace = input.workspace ?? session.workspace_hint ?? undefined;
    if (!workspace) {
      throw new HubError(
        'workspace_required',
        'no workspace given and none configured for this session',
        {
          hint: 'pass workspace, or add { "workspace": "<name>" } to .agent-link.json in the repository root',
        },
      );
    }
    const { agent, token, previous } = stores.agents.register({
      session_id: input.session_id,
      name: input.name,
      description: input.description,
      capabilities: input.capabilities,
      workspace,
      kind: input.kind,
      provisional: input.provisional,
      window: input.window,
      agent_id: input.agent_id,
      watcher: input.watcher,
    });
    stores.sessions.linkAgent(input.session_id, agent.id);
    deps.presence.forget(agent.id);
    if (previous?.status === 'online' && previous.workspace === agent.workspace) {
      if (previous.name !== agent.name || previous.provisional !== agent.provisional) {
        announcePeer(deps, agent.id, 'updated', previous.name);
      }
    } else {
      announcePeer(deps, agent.id, 'joined');
    }
    const was = previous && !previous.provisional ? previous : undefined;
    if (!agent.provisional && agent.kind === 'human' && was?.kind !== 'human') {
      flag(
        deps,
        agent,
        'became-human',
        'flagged',
        'registered as a human relay (may quarantine and release agents and read the audit view)',
        { exceptId: agent.id },
      );
    }
    if (!agent.provisional && agent.watcher && !was?.watcher) {
      flag(
        deps,
        agent,
        'became-watcher',
        'flagged',
        'registered as a watcher (may read every conversation of the workspace)',
        { exceptId: agent.id },
      );
    }
    const body: RegisterResponse = {
      agent,
      token,
      peers: stores.agents.peers(workspace, agent.id),
    };
    return { status: 201, body };
  });

  router.add('DELETE', '/v1/agents/:id', ({ req, params }) => {
    const agent = requireAgent(stores.agents, req, params['id'] ?? '');
    deps.presence.forget(agent.id);
    takeOffline(deps, agent.id);
    return undefined;
  });

  router.add('GET', '/v1/workspaces/:ws/agents', ({ req, params }) => {
    const agent = requireWorkspace(stores.agents, req, params['ws'] ?? '');
    stores.agents.touch(agent.id);
    return { body: stores.agents.peers(agent.workspace, agent.id) };
  });
}
