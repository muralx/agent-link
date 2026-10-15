import { z } from 'zod';

/**
 * NAME_PATTERN constrains agent and workspace names: 1 to 64 ASCII letters,
 * digits, dot, underscore or dash, starting with a letter or digit.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * NameSchema validates an agent name (see NAME_PATTERN); names are unique among
 * online agents of a workspace, the hub suffixes -2, -3 on collision.
 */
export const NameSchema = z.string().regex(NAME_PATTERN);
/**
 * WorkspaceSchema validates a workspace name, the visibility boundary between
 * agents (same pattern as agent names).
 */
export const WorkspaceSchema = z.string().regex(NAME_PATTERN);
/**
 * MessageBodySchema validates a message body: non-empty markdown of at most
 * 65536 characters; anything else is an invalid_message error.
 */
export const MessageBodySchema = z.string().min(1).max(65536);
/**
 * ProseSchema validates free-text profile fields (description, capabilities): 1
 * to 4000 characters.
 */
export const ProseSchema = z.string().min(1).max(4000);

/**
 * ExpectationSchema is the only typed field on a message: reply (the sender
 * wants an answer), none (for information), updates (keep the sender posted
 * until a final message).
 */
export const ExpectationSchema = z.enum(['reply', 'none', 'updates']);
/** Expectation is the parsed form of ExpectationSchema. */
export type Expectation = z.infer<typeof ExpectationSchema>;

/**
 * AgentKindSchema distinguishes an LLM agent from a human relay session (kind
 * human); the Stop hook never blocks a human and peers expect human-scale
 * latency from one.
 */
export const AgentKindSchema = z.enum(['agent', 'human']);
/** AgentKind is the parsed form of AgentKindSchema. */
export type AgentKind = z.infer<typeof AgentKindSchema>;

/**
 * AgentStatusSchema is an agent's presence: online while its edge is connected
 * (plus a 30 s grace), offline afterwards; offline rows stay for history.
 */
export const AgentStatusSchema = z.enum(['online', 'offline']);
/** AgentStatus is the parsed form of AgentStatusSchema. */
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * DeliveryStateSchema tracks one recipient's copy of a message: queued on send,
 * notified once a channel notification or hook surfaced it, read once the agent
 * fetched it or replied in the conversation.
 */
export const DeliveryStateSchema = z.enum(['queued', 'notified', 'read']);
/** DeliveryState is the parsed form of DeliveryStateSchema. */
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

/**
 * DeliveryViaSchema records which path moved a delivery to its state: channel,
 * hook, await, inbox, conversation or reply.
 */
export const DeliveryViaSchema = z.enum([
  'channel',
  'hook',
  'await',
  'inbox',
  'conversation',
  'reply',
]);
/** DeliveryVia is the parsed form of DeliveryViaSchema. */
export type DeliveryVia = z.infer<typeof DeliveryViaSchema>;

/**
 * ErrorCodeSchema enumerates every error code the hub API and the edge tools
 * can return; tools return these as data, never as protocol errors, so an agent
 * can read and act on them. quarantined means the guard blocked the caller's
 * sends until a human releases it.
 */
export const ErrorCodeSchema = z.enum([
  'hub_unavailable',
  'not_registered',
  'session_required',
  'workspace_required',
  'peer_not_found',
  'not_participant',
  'invalid_message',
  'unauthorized',
  'not_found',
  'quarantined',
]);
/** ErrorCode is the parsed form of ErrorCodeSchema. */
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * ApiErrorSchema is the error body of every failed hub call and failed tool:
 * error code, human message, optional hint, plus loose extra fields such as
 * online (the peers that are reachable) on peer_not_found.
 */
export const ApiErrorSchema = z
  .object({
    error: ErrorCodeSchema,
    message: z.string(),
    hint: z.string().optional(),
  })
  .loose();
/** ApiError is the parsed form of ApiErrorSchema. */
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * PeerSchema is what an agent sees of another agent in its workspace: name,
 * prose description and capabilities, kind, whether it is still provisional
 * (auto-registered by its edge, not yet identified by the model), when it was
 * last seen, whether it registered as a watcher (may read the workspace audit
 * view) and whether the guard has quarantined it (its sends are refused until
 * a human releases it); ids and tokens are never exposed to peers. watcher and
 * quarantined default to false so answers from a hub that predates the guard
 * still parse.
 */
export const PeerSchema = z.object({
  name: NameSchema,
  description: z.string(),
  capabilities: z.string(),
  kind: AgentKindSchema,
  provisional: z.boolean(),
  last_seen: z.string(),
  watcher: z.boolean().default(false),
  quarantined: z.boolean().default(false),
});
/** Peer is the parsed form of PeerSchema. */
export type Peer = z.infer<typeof PeerSchema>;

/**
 * AgentSchema is an agent's own full record as returned by register: a Peer
 * plus id, workspace, status, session_id, window (the Claude Code window id, or
 * null) and registered_at.
 */
export const AgentSchema = PeerSchema.extend({
  id: z.string(),
  workspace: WorkspaceSchema,
  status: AgentStatusSchema,
  session_id: z.string(),
  window: z.string().nullable(),
  registered_at: z.string(),
});
/** Agent is the parsed form of AgentSchema. */
export type Agent = z.infer<typeof AgentSchema>;

/**
 * MessageSchema is a message as returned everywhere: from and to carry agent
 * names, in_reply_to is informational (latest message from another participant
 * at send time, or an explicit override), created_at is an ISO timestamp.
 */
export const MessageSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  body: z.string(),
  expectation: ExpectationSchema,
  final: z.boolean(),
  in_reply_to: z.string().nullable(),
  created_at: z.string(),
});
/** Message is the parsed form of MessageSchema. */
export type Message = z.infer<typeof MessageSchema>;

/**
 * ConversationSchema is a conversation's header; participants are listed
 * separately because they can grow after creation.
 */
export const ConversationSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  subject: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
/** Conversation is the parsed form of ConversationSchema. */
export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * OpenExpectationSchema describes one message still waiting on the agent: a
 * reply expectation not yet answered, or an updates expectation not yet closed
 * with final.
 */
export const OpenExpectationSchema = z.object({
  message_id: z.string(),
  conversation_id: z.string(),
  from: z.string(),
  expectation: ExpectationSchema,
  created_at: z.string(),
});
/** OpenExpectation is the parsed form of OpenExpectationSchema. */
export type OpenExpectation = z.infer<typeof OpenExpectationSchema>;

/**
 * ConversationSummarySchema is one row of the conversations tool: header fields
 * plus the caller's unread count and open_for_me, the expectations waiting on
 * the caller.
 */
export const ConversationSummarySchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  participants: z.array(z.string()),
  last_message_at: z.string().nullable(),
  unread: z.number().int().nonnegative(),
  open_for_me: z.array(OpenExpectationSchema),
});
/** ConversationSummary is the parsed form of ConversationSummarySchema. */
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

/**
 * RegisterInputSchema is the register tool's input. session_id is optional for
 * the tool because the edge knows its own session; workspace falls back to
 * .agent-link.json; kind defaults to agent; provisional defaults to false and
 * is set only by the edge's automatic registration; watcher defaults to false
 * and asks for read access to the workspace audit view (the hub records an
 * incident and tells the humans when an agent becomes a watcher).
 */
export const RegisterInputSchema = z.object({
  session_id: z.string().min(1).optional(),
  name: NameSchema,
  description: ProseSchema,
  capabilities: ProseSchema,
  workspace: WorkspaceSchema.optional(),
  kind: AgentKindSchema.default('agent'),
  provisional: z.boolean().default(false),
  watcher: z.boolean().default(false),
});
/** RegisterInput is the parsed form of RegisterInputSchema. */
export type RegisterInput = z.infer<typeof RegisterInputSchema>;

/**
 * RecipientsSchema is a send target: the literal '*' for every online peer in
 * the workspace, or a non-empty list of peer names.
 */
export const RecipientsSchema = z.union([z.literal('*'), z.array(NameSchema).min(1)]);
/** Recipients is the parsed form of RecipientsSchema. */
export type Recipients = z.infer<typeof RecipientsSchema>;

/**
 * SendInputSchema is the send tool's input; to is required when no
 * conversation_id is given, expectation defaults to none and final to false.
 */
export const SendInputSchema = z
  .object({
    to: RecipientsSchema.optional(),
    body: MessageBodySchema,
    expectation: ExpectationSchema.default('none'),
    subject: z.string().max(200).optional(),
    conversation_id: z.string().optional(),
    in_reply_to: z.string().optional(),
    final: z.boolean().default(false),
  })
  .refine((v) => v.to !== undefined || v.conversation_id !== undefined, {
    message: 'to is required when starting a conversation',
    path: ['to'],
  });
/** SendInput is the parsed form of SendInputSchema. */
export type SendInput = z.infer<typeof SendInputSchema>;

/**
 * ReplyInputSchema is the reply tool's input: a body into an existing
 * conversation, addressed to its other participants.
 */
export const ReplyInputSchema = z.object({
  conversation_id: z.string().min(1),
  body: MessageBodySchema,
  expectation: ExpectationSchema.default('none'),
  in_reply_to: z.string().optional(),
  final: z.boolean().default(false),
});
/** ReplyInput is the parsed form of ReplyInputSchema. */
export type ReplyInput = z.infer<typeof ReplyInputSchema>;

/**
 * AWAIT_DEFAULT_TIMEOUT_S is how long the await tool waits when no timeout is
 * given (600 s).
 */
export const AWAIT_DEFAULT_TIMEOUT_S = 600;
/**
 * AWAIT_MAX_TIMEOUT_S caps the await tool's timeout (1500 s), below Claude
 * Code's 30 min stdio idle timeout.
 */
export const AWAIT_MAX_TIMEOUT_S = 1500;

/**
 * AwaitInputSchema is the await tool's input: optionally narrow to a
 * conversation or to messages after a given message, with a timeout in seconds.
 */
export const AwaitInputSchema = z.object({
  conversation_id: z.string().optional(),
  message_id: z.string().optional(),
  timeout_s: z.number().int().min(1).max(AWAIT_MAX_TIMEOUT_S).default(AWAIT_DEFAULT_TIMEOUT_S),
});
/** AwaitInput is the parsed form of AwaitInputSchema. */
export type AwaitInput = z.infer<typeof AwaitInputSchema>;

/**
 * InboxInputSchema is the inbox tool's input: unread_only defaults to true,
 * limit to 50 (max 200).
 */
export const InboxInputSchema = z.object({
  unread_only: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(50),
});
/** InboxInput is the parsed form of InboxInputSchema. */
export type InboxInput = z.infer<typeof InboxInputSchema>;

/**
 * ConversationInputSchema is the conversation tool's input; since is a message
 * id and returns only the messages after it.
 */
export const ConversationInputSchema = z.object({
  conversation_id: z.string().min(1),
  since: z.string().optional(),
});
/** ConversationInput is the parsed form of ConversationInputSchema. */
export type ConversationInput = z.infer<typeof ConversationInputSchema>;

/**
 * ConversationsInputSchema is the conversations tool's input; open_only keeps
 * only conversations with something waiting on the caller.
 */
export const ConversationsInputSchema = z.object({
  open_only: z.boolean().default(false),
});
/** ConversationsInput is the parsed form of ConversationsInputSchema. */
export type ConversationsInput = z.infer<typeof ConversationsInputSchema>;

/**
 * RegisterRequestSchema is the hub's POST /v1/agents body: RegisterInput with
 * session_id made mandatory (the hub keys reclaim on it), plus the edge's cwd
 * for the session row, its window id for reclaim across session switches and,
 * when the edge already has an identity, agent_id (the request then carries
 * that agent's bearer token and upgrades that very agent).
 */
export const RegisterRequestSchema = RegisterInputSchema.extend({
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  window: z.string().optional(),
  agent_id: z.string().optional(),
});
/** RegisterRequest is the parsed form of RegisterRequestSchema. */
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
/**
 * RegisterRequestInput is what a client may send as the body (defaults such as
 * kind and provisional still optional).
 */
export type RegisterRequestInput = z.input<typeof RegisterRequestSchema>;

/**
 * RegisterResponseSchema is the hub's answer to a registration: the agent
 * record, the bearer token for later calls, and the current peers.
 */
export const RegisterResponseSchema = z.object({
  agent: AgentSchema,
  token: z.string(),
  peers: z.array(PeerSchema),
});
/** RegisterResponse is the parsed form of RegisterResponseSchema. */
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

/**
 * SendResponseSchema reports a successful send: the new message and
 * conversation ids, which recipients were online (delivered_to) and which
 * existing participants were offline.
 */
export const SendResponseSchema = z.object({
  message_id: z.string(),
  conversation_id: z.string(),
  delivered_to: z.array(z.string()),
  offline: z.array(z.string()),
});
/** SendResponse is the parsed form of SendResponseSchema. */
export type SendResponse = z.infer<typeof SendResponseSchema>;

/**
 * AwaitResponseSchema is the await result: the messages that satisfied the wait
 * (now read), or an empty list with timed_out true.
 */
export const AwaitResponseSchema = z.object({
  messages: z.array(MessageSchema),
  timed_out: z.boolean(),
});
/** AwaitResponse is the parsed form of AwaitResponseSchema. */
export type AwaitResponse = z.infer<typeof AwaitResponseSchema>;

/** InboxResponseSchema wraps the messages returned by the inbox tool. */
export const InboxResponseSchema = z.object({ messages: z.array(MessageSchema) });
/** InboxResponse is the parsed form of InboxResponseSchema. */
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

/**
 * ConversationResponseSchema is a full thread: header, participant names and
 * messages in creation order.
 */
export const ConversationResponseSchema = z.object({
  conversation: ConversationSchema,
  participants: z.array(z.string()),
  messages: z.array(MessageSchema),
});
/** ConversationResponse is the parsed form of ConversationResponseSchema. */
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

/**
 * ConversationsResponseSchema is the list returned by the conversations tool.
 */
export const ConversationsResponseSchema = z.array(ConversationSummarySchema);
/** ConversationsResponse is the parsed form of ConversationsResponseSchema. */
export type ConversationsResponse = z.infer<typeof ConversationsResponseSchema>;

/**
 * SessionSchema is a stored Claude Code session: its id, cwd and workspace hint
 * from the hook, the window id it was last seen in, and the agent it is linked
 * to (null until registration).
 */
export const SessionSchema = z.object({
  session_id: z.string(),
  cwd: z.string().nullable(),
  workspace_hint: z.string().nullable(),
  window: z.string().nullable(),
  agent_id: z.string().nullable(),
});
/** Session is the parsed form of SessionSchema. */
export type Session = z.infer<typeof SessionSchema>;

/**
 * SessionUpsertRequestSchema is the SessionStart hook's POST /v1/sessions body:
 * session id, cwd, workspace hint, the hook's window id (lets the hub relink a
 * window's agent after /clear or /resume) and the hook's source (startup,
 * resume, clear, compact).
 */
export const SessionUpsertRequestSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  workspace_hint: z.string().optional(),
  window: z.string().optional(),
  source: z.string().optional(),
});
/** SessionUpsertRequest is the parsed form of SessionUpsertRequestSchema. */
export type SessionUpsertRequest = z.infer<typeof SessionUpsertRequestSchema>;

/**
 * SessionUpsertResponseSchema returns the stored session, the agent it maps to
 * (the live window's agent after a relink, else the session's own, else null)
 * and previous: a different agent the session id was bound to before the
 * relink, or null.
 */
export const SessionUpsertResponseSchema = z.object({
  session: SessionSchema,
  agent: AgentSchema.nullable(),
  previous: AgentSchema.nullable(),
});
/** SessionUpsertResponse is the parsed form of SessionUpsertResponseSchema. */
export type SessionUpsertResponse = z.infer<typeof SessionUpsertResponseSchema>;

/**
 * HookAgentSchema is the slice of an agent the hooks need: its name, kind and
 * whether it is still provisional (auto-registered, not yet identified).
 */
export const HookAgentSchema = z.object({
  name: z.string(),
  kind: AgentKindSchema,
  provisional: z.boolean(),
});
/** HookAgent is the parsed form of HookAgentSchema. */
export type HookAgent = z.infer<typeof HookAgentSchema>;

/**
 * PendingResponseSchema is what the UserPromptSubmit and PostToolUse hooks
 * receive: the agent's hook slice (or null for an unknown session), the
 * messages to surface (now marked notified) and the reply expectations still
 * open for it.
 */
export const PendingResponseSchema = z.object({
  agent: HookAgentSchema.nullable(),
  messages: z.array(MessageSchema),
  open_replies: z.array(OpenExpectationSchema),
});
/** PendingResponse is the parsed form of PendingResponseSchema. */
export type PendingResponse = z.infer<typeof PendingResponseSchema>;

/**
 * OpenResponseSchema is the Stop hook's read-only view: the agent's hook slice
 * (name, kind, provisional) or null, and the open reply expectations addressed
 * to it; it never changes delivery state.
 */
export const OpenResponseSchema = z.object({
  agent: HookAgentSchema.nullable(),
  open_replies: z.array(OpenExpectationSchema),
});
/** OpenResponse is the parsed form of OpenResponseSchema. */
export type OpenResponse = z.infer<typeof OpenResponseSchema>;

/**
 * DeliveryAckRequestSchema is the body the edge posts after emitting a channel
 * notification, moving a delivery to notified via channel.
 */
export const DeliveryAckRequestSchema = z.object({
  state: DeliveryStateSchema,
  via: DeliveryViaSchema,
});
/** DeliveryAckRequest is the parsed form of DeliveryAckRequestSchema. */
export type DeliveryAckRequest = z.infer<typeof DeliveryAckRequestSchema>;

/**
 * HealthResponseSchema is the GET /v1/health body the edge and launcher use to
 * detect a running hub.
 */
export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  pid: z.number().int(),
});
/** HealthResponse is the parsed form of HealthResponseSchema. */
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * MessageEventSchema is the SSE event the hub sends an edge for each inbound
 * message, with the conversation subject and participant names needed to render
 * it.
 */
export const MessageEventSchema = z.object({
  type: z.literal('message'),
  message: MessageSchema,
  subject: z.string().nullable(),
  participants: z.array(z.string()),
});
/** MessageEvent is the parsed form of MessageEventSchema. */
export type MessageEvent = z.infer<typeof MessageEventSchema>;

/**
 * PeerEventSchema is the SSE event announcing a peer change in the workspace:
 * joined, left, or updated when a reclaim changed the peer's identity
 * (previous_name says what it was called). It carries the peer's name,
 * description, kind and provisional flag. The edge surfaces joined and updated
 * and ignores left.
 */
export const PeerEventSchema = z.object({
  type: z.literal('peer'),
  event: z.enum(['joined', 'left', 'updated']),
  name: z.string(),
  description: z.string(),
  kind: AgentKindSchema,
  provisional: z.boolean(),
  previous_name: z.string().optional(),
});
/** PeerEvent is the parsed form of PeerEventSchema. */
export type PeerEvent = z.infer<typeof PeerEventSchema>;

/**
 * HubEventSchema is the union of events on an edge's SSE stream, discriminated
 * on type.
 */
export const HubEventSchema = z.discriminatedUnion('type', [MessageEventSchema, PeerEventSchema]);
/** HubEvent is the parsed form of HubEventSchema. */
export type HubEvent = z.infer<typeof HubEventSchema>;

/**
 * GUARD_NAME is the reserved name of the hub's system sender: guard notices to
 * humans come from it, and an agent asking for this name is given a suffixed
 * one.
 */
export const GUARD_NAME = 'guard';

/**
 * GuardRuleSchema names what an incident is about: the four automatic limits
 * (rate: too many messages per minute; loop: too many messages in one
 * conversation with no human taking part; repeat: the same body sent again and
 * again; broadcast: too many "*" sends), manual (a human acted), request (a
 * watcher or human asked for a quarantine) and the two role changes the hub
 * flags (became-human, became-watcher).
 */
export const GuardRuleSchema = z.enum([
  'rate',
  'loop',
  'repeat',
  'broadcast',
  'manual',
  'request',
  'became-human',
  'became-watcher',
]);
/** GuardRule is the parsed form of GuardRuleSchema. */
export type GuardRule = z.infer<typeof GuardRuleSchema>;

/**
 * IncidentActionSchema is what the hub did when it recorded an incident:
 * quarantined or released the agent, noted a request for a quarantine, or only
 * flagged the event.
 */
export const IncidentActionSchema = z.enum(['quarantined', 'released', 'requested', 'flagged']);
/** IncidentAction is the parsed form of IncidentActionSchema. */
export type IncidentAction = z.infer<typeof IncidentActionSchema>;

/**
 * IncidentSchema is one entry of the guard's log: the agent it concerns (by its
 * current name), the rule, the action taken, a prose detail, who caused it (an
 * agent name, or "guard" for the hub's own rules) and when.
 */
export const IncidentSchema = z.object({
  id: z.string(),
  agent: z.string(),
  rule: GuardRuleSchema,
  action: IncidentActionSchema,
  detail: z.string(),
  by: z.string(),
  created_at: z.string(),
});
/** Incident is the parsed form of IncidentSchema. */
export type Incident = z.infer<typeof IncidentSchema>;

/**
 * QuarantinedAgentSchema is one quarantined agent in the guard status: its
 * name, kind of presence, the reason recorded and since when.
 */
export const QuarantinedAgentSchema = z.object({
  name: z.string(),
  status: AgentStatusSchema,
  reason: z.string(),
  since: z.string(),
});
/** QuarantinedAgent is the parsed form of QuarantinedAgentSchema. */
export type QuarantinedAgent = z.infer<typeof QuarantinedAgentSchema>;

/**
 * GuardStatusResponseSchema is GET /v1/workspaces/:ws/guard: the agents
 * currently quarantined and the most recent incidents, newest first.
 */
export const GuardStatusResponseSchema = z.object({
  quarantined: z.array(QuarantinedAgentSchema),
  incidents: z.array(IncidentSchema),
});
/** GuardStatusResponse is the parsed form of GuardStatusResponseSchema. */
export type GuardStatusResponse = z.infer<typeof GuardStatusResponseSchema>;

/**
 * GuardActionRequestSchema is the body of the guard's quarantine, release and
 * request routes: the agent's name and an optional reason of at most 1000
 * characters.
 */
export const GuardActionRequestSchema = z.object({
  name: NameSchema,
  reason: z.string().min(1).max(1000).optional(),
});
/** GuardActionRequest is the parsed form of GuardActionRequestSchema. */
export type GuardActionRequest = z.infer<typeof GuardActionRequestSchema>;

/**
 * GuardInputSchema is the guard tool's input. status needs nothing; quarantine,
 * release and request need the agent's name, and quarantine and request a
 * reason.
 */
export const GuardInputSchema = z
  .object({
    action: z.enum(['status', 'quarantine', 'release', 'request']),
    name: NameSchema.optional(),
    reason: z.string().min(1).max(1000).optional(),
  })
  .refine((v) => v.action === 'status' || v.name !== undefined, {
    message: 'name is required for quarantine, release and request',
    path: ['name'],
  })
  .refine((v) => (v.action !== 'quarantine' && v.action !== 'request') || v.reason !== undefined, {
    message: 'reason is required for quarantine and request',
    path: ['reason'],
  });
/** GuardInput is the parsed form of GuardInputSchema. */
export type GuardInput = z.infer<typeof GuardInputSchema>;

/**
 * AuditConversationSchema is one row of the workspace audit listing: the
 * conversation header, its participant names, how many messages it holds and
 * when the last one was sent.
 */
export const AuditConversationSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  participants: z.array(z.string()),
  created_at: z.string(),
  messages: z.number().int().nonnegative(),
  last_message_at: z.string().nullable(),
});
/** AuditConversation is the parsed form of AuditConversationSchema. */
export type AuditConversation = z.infer<typeof AuditConversationSchema>;

/**
 * AuditConversationsResponseSchema is the audit listing, most recently active
 * conversation first.
 */
export const AuditConversationsResponseSchema = z.array(AuditConversationSchema);
/**
 * AuditConversationsResponse is the parsed form of
 * AuditConversationsResponseSchema.
 */
export type AuditConversationsResponse = z.infer<typeof AuditConversationsResponseSchema>;

/**
 * AuditFeedResponseSchema is one page of the workspace message feed: messages
 * in creation order after the cursor asked for, the cursor to pass next (the
 * last message id seen, unchanged when the page is empty, null when the
 * workspace has no messages yet) and timed_out, true when a wait ended without
 * anything new.
 */
export const AuditFeedResponseSchema = z.object({
  messages: z.array(MessageSchema),
  cursor: z.string().nullable(),
  timed_out: z.boolean(),
});
/** AuditFeedResponse is the parsed form of AuditFeedResponseSchema. */
export type AuditFeedResponse = z.infer<typeof AuditFeedResponseSchema>;

/**
 * AUDIT_MAX_WAIT_S caps the audit tool's feed wait (1500 s), the same bound as
 * await.
 */
export const AUDIT_MAX_WAIT_S = 1500;

/**
 * AuditInputSchema is the audit tool's input. conversations lists every
 * conversation of the workspace; conversation reads one thread (conversation_id
 * required); feed returns messages after since (a message id; omit it to start
 * from the newest message), at most limit, waiting up to wait_s seconds for
 * something new; incidents returns the guard status.
 */
export const AuditInputSchema = z
  .object({
    action: z.enum(['conversations', 'conversation', 'feed', 'incidents']),
    conversation_id: z.string().min(1).optional(),
    since: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    wait_s: z.number().int().min(0).max(AUDIT_MAX_WAIT_S).default(0),
  })
  .refine((v) => v.action !== 'conversation' || v.conversation_id !== undefined, {
    message: 'conversation_id is required to read a conversation',
    path: ['conversation_id'],
  });
/** AuditInput is the parsed form of AuditInputSchema. */
export type AuditInput = z.infer<typeof AuditInputSchema>;
