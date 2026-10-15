import type { IncomingMessage } from 'node:http';
import type { Agent } from '@agent-link/protocol';
import { bearerToken } from './http.ts';
import type { AgentStore } from './store/agents.ts';
import { HubError } from './store/errors.ts';

/**
 * authenticate resolves the request's bearer token to its online agent,
 * throwing unauthorized (401) when the header is missing or the token unknown
 * or expired.
 */
export function authenticate(agents: AgentStore, req: IncomingMessage): Agent {
  const token = bearerToken(req);
  if (!token) throw new HubError('unauthorized', 'missing bearer token');
  const agent = agents.byToken(token);
  if (!agent) {
    throw new HubError('unauthorized', 'unknown or expired token', {
      hint: 'register again to obtain a fresh token',
    });
  }
  return agent;
}

/**
 * requireAgent authenticates and additionally requires the token to belong to
 * agentId, else 403.
 */
export function requireAgent(agents: AgentStore, req: IncomingMessage, agentId: string): Agent {
  const agent = authenticate(agents, req);
  if (agent.id !== agentId) {
    throw new HubError('unauthorized', 'token does not belong to this agent', { status: 403 });
  }
  return agent;
}

/**
 * requireWorkspace authenticates and additionally requires the agent to belong
 * to workspace, else 403; it is how workspace visibility is enforced.
 */
export function requireWorkspace(
  agents: AgentStore,
  req: IncomingMessage,
  workspace: string,
): Agent {
  const agent = authenticate(agents, req);
  if (agent.workspace !== workspace) {
    throw new HubError('unauthorized', 'you can only see your own workspace', { status: 403 });
  }
  return agent;
}
