import {
  ApiErrorSchema,
  AuditConversationsResponseSchema,
  AuditFeedResponseSchema,
  AwaitResponseSchema,
  ConversationResponseSchema,
  ConversationsResponseSchema,
  GuardStatusResponseSchema,
  HealthResponseSchema,
  IncidentSchema,
  HubEventSchema,
  InboxResponseSchema,
  OpenResponseSchema,
  PeerSchema,
  PendingResponseSchema,
  RegisterResponseSchema,
  SendResponseSchema,
  SessionUpsertResponseSchema,
  type AuditConversationsResponse,
  type AuditFeedResponse,
  type AwaitInput,
  type AwaitResponse,
  type ConversationResponse,
  type ConversationsResponse,
  type DeliveryState,
  type DeliveryVia,
  type ErrorCode,
  type GuardStatusResponse,
  type HealthResponse,
  type HubEvent,
  type InboxInput,
  type InboxResponse,
  type Incident,
  type OpenResponse,
  type Peer,
  type PendingResponse,
  type RegisterRequestInput,
  type RegisterResponse,
  type SendInput,
  type SendResponse,
  type SessionUpsertRequest,
  type SessionUpsertResponse,
} from '@agent-link/protocol';
import { z, type ZodType } from 'zod';

/**
 * HubApiErrorOptions carries the optional hint, extra fields and HTTP status of
 * a HubApiError.
 */
export interface HubApiErrorOptions {
  hint?: string | undefined;
  extra?: Record<string, unknown> | undefined;
  status?: number | undefined;
}

/**
 * HubApiError is how the edge sees any hub failure: the protocol ErrorCode,
 * message, optional hint, extra fields from the API body and the HTTP status
 * when there was one. toToolError renders it as the JSON an agent reads.
 */
export class HubApiError extends Error {
  /**
   * The protocol ErrorCode the hub answered with, or the one the edge chose
   * when the hub gave no protocol body ('unauthorized' for 401/403,
   * 'hub_unavailable' otherwise). toToolError emits it as the error field.
   */
  readonly code: ErrorCode;
  /**
   * The optional hint from the hub's error body telling the agent what to do
   * next; undefined when the hub sent none or the error was synthesized from an
   * HTTP status. toToolError only includes it when defined.
   */
  readonly hint: string | undefined;
  /**
   * The fields of the hub's error body other than error, message and hint, such
   * as online on peer_not_found. Always an object, empty when there were none,
   * so it is safe to spread; toToolError spreads it under the standard fields.
   */
  readonly extra: Record<string, unknown>;
  /**
   * The HTTP status of the hub response that produced this error, or undefined
   * when the error did not come from an HTTP response. Not part of the object
   * toToolError returns.
   */
  readonly status: number | undefined;

  /**
   * Creates a HubApiError with the given protocol code and message, naming the
   * error 'HubApiError'.
   *
   * options.hint and options.status are kept as given (undefined when absent);
   * options.extra defaults to an empty object so extra is always safe to
   * spread.
   */
  constructor(code: ErrorCode, message: string, options: HubApiErrorOptions = {}) {
    super(message);
    this.name = 'HubApiError';
    this.code = code;
    this.hint = options.hint;
    this.extra = options.extra ?? {};
    this.status = options.status;
  }

  /**
   * toToolError renders the error as the object returned to the agent: extra
   * fields, error, message and hint.
   */
  toToolError(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ...this.extra,
      error: this.code,
      message: this.message,
    };
    if (this.hint !== undefined) body['hint'] = this.hint;
    return body;
  }
}

/**
 * SubscribeOptions configures subscribeEvents: the event callback, optional
 * connect and error callbacks, and the backoff bounds.
 */
export interface SubscribeOptions {
  onEvent: (event: HubEvent, id: string | undefined) => void;
  onConnect?: () => void;
  onError?: (err: unknown) => void;
  backoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * EventSubscription is a running SSE subscription; stop() aborts it and
 * prevents reconnects.
 */
export interface EventSubscription {
  stop(): void;
}

/** FetchLike is the fetch signature, injectable for tests. */
export type FetchLike = typeof fetch;

const EmptySchema = z.unknown();

/** windowQuery renders the optional ?window= query string for session routes. */
function windowQuery(window: string | undefined): string {
  return window ? `?window=${enc(window)}` : '';
}

/**
 * HubClient is the edge's typed client for the hub HTTP API: one method per
 * route, every response validated against the protocol schemas, every failure
 * surfaced as a HubApiError (network failures as hub_unavailable), plus
 * subscribeEvents for the SSE stream with automatic resume. register optionally
 * carries the edge's current bearer token so a registration can upgrade the
 * agent the edge already is. The guard and audit methods (guardStatus,
 * guardAction, auditConversations, auditConversation, auditFeed) answer
 * not_found against a hub that predates the guard.
 */
export class HubClient {
  /**
   * The hub's base URL as given to the constructor, with trailing slashes
   * removed so route paths can be appended directly.
   *
   * Read-only after construction; it is the prefix every request and the SSE
   * subscription are sent to.
   */
  readonly baseUrl: string;
  readonly #fetch: FetchLike;

  /**
   * Creates a client for the hub at baseUrl, storing it with any trailing
   * slashes removed so paths can be appended directly.
   *
   * fetchImpl defaults to the global fetch and exists so tests can inject a
   * fake; no request is made at construction.
   */
  constructor(baseUrl: string, fetchImpl: FetchLike = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchImpl;
  }

  /**
   * health calls GET /v1/health; rejects with hub_unavailable when nothing
   * answers.
   */
  health(): Promise<HealthResponse> {
    return this.#call('GET', '/v1/health', HealthResponseSchema);
  }

  /**
   * sessionUpsert records a session (SessionStart hook) and returns its agent
   * if it has one.
   */
  sessionUpsert(body: SessionUpsertRequest): Promise<SessionUpsertResponse> {
    return this.#call('POST', '/v1/sessions', SessionUpsertResponseSchema, { body });
  }

  /**
   * sessionPending fetches the messages a hook should surface for the session's
   * agent (found by session id, or by window id when the window switched
   * sessions), marking them notified on the hub, plus the agent's hook slice.
   */
  sessionPending(sessionId: string, window?: string): Promise<PendingResponse> {
    return this.#call(
      'GET',
      `/v1/sessions/${enc(sessionId)}/pending${windowQuery(window)}`,
      PendingResponseSchema,
    );
  }

  /**
   * sessionOpen fetches the Stop hook's read-only view: the agent's hook slice
   * plus open reply expectations; window is used like in sessionPending.
   */
  sessionOpen(sessionId: string, window?: string): Promise<OpenResponse> {
    return this.#call(
      'GET',
      `/v1/sessions/${enc(sessionId)}/open${windowQuery(window)}`,
      OpenResponseSchema,
    );
  }

  /**
   * sessionEnd reports the SessionEnd hook for the session (and window, when
   * known); the hub takes the agent offline unless its edge still holds a
   * stream.
   */
  async sessionEnd(sessionId: string, window?: string): Promise<void> {
    await this.#call(
      'POST',
      `/v1/sessions/${enc(sessionId)}/end${windowQuery(window)}`,
      EmptySchema,
    );
  }

  /**
   * register creates, reclaims or (with provisional true) reconnects the agent
   * and returns the agent, its bearer token and current peers; the body is the
   * schema's input form, so defaults may be omitted. When the body names the
   * edge's current agent_id, token must be that agent's bearer token.
   */
  register(body: RegisterRequestInput, token?: string): Promise<RegisterResponse> {
    return this.#call('POST', '/v1/agents', RegisterResponseSchema, {
      body,
      ...(token === undefined ? {} : { token }),
    });
  }

  /** unregister takes the agent offline using its token. */
  async unregister(agentId: string, token: string): Promise<void> {
    await this.#call('DELETE', `/v1/agents/${enc(agentId)}`, EmptySchema, { token });
  }

  /**
   * peers lists the online agents of the workspace other than the caller;
   * unauthorized if the token is not a member.
   */
  peers(workspace: string, token: string): Promise<Peer[]> {
    return this.#call('GET', `/v1/workspaces/${enc(workspace)}/agents`, z.array(PeerSchema), {
      token,
    });
  }

  /**
   * send posts a message or reply as the token's agent and returns the
   * SendResponse; peer_not_found carries the online names in extra.
   */
  send(token: string, input: SendInput): Promise<SendResponse> {
    return this.#call('POST', '/v1/messages', SendResponseSchema, { token, body: input });
  }

  /**
   * inbox fetches the agent's messages (unread only by default) and marks them
   * read on the hub.
   */
  inbox(agentId: string, token: string, input: InboxInput): Promise<InboxResponse> {
    const q = new URLSearchParams({
      unread_only: String(input.unread_only),
      limit: String(input.limit),
    });
    return this.#call(
      'GET',
      `/v1/agents/${enc(agentId)}/inbox?${q.toString()}`,
      InboxResponseSchema,
      { token },
    );
  }

  /**
   * conversations lists the agent's conversation summaries, optionally only
   * those with something open for it.
   */
  conversations(agentId: string, token: string, openOnly: boolean): Promise<ConversationsResponse> {
    const q = new URLSearchParams({ open_only: String(openOnly) });
    return this.#call(
      'GET',
      `/v1/agents/${enc(agentId)}/conversations?${q.toString()}`,
      ConversationsResponseSchema,
      { token },
    );
  }

  /**
   * conversation fetches a thread, or only the messages after since, marking
   * the returned ones read.
   */
  conversation(
    token: string,
    conversationId: string,
    since?: string,
  ): Promise<ConversationResponse> {
    const q = since ? `?since=${enc(since)}` : '';
    return this.#call(
      'GET',
      `/v1/conversations/${enc(conversationId)}${q}`,
      ConversationResponseSchema,
      { token },
    );
  }

  /**
   * await long-polls the hub for up to timeout_s seconds (the hub caps one
   * request at 25 s) and resolves with matching unread messages or timed_out;
   * signal aborts the request.
   */
  await(
    agentId: string,
    token: string,
    input: AwaitInput,
    signal?: AbortSignal,
  ): Promise<AwaitResponse> {
    const q = new URLSearchParams({ timeout_s: String(input.timeout_s) });
    if (input.conversation_id) q.set('conversation', input.conversation_id);
    if (input.message_id) q.set('message', input.message_id);
    return this.#call(
      'GET',
      `/v1/agents/${enc(agentId)}/await?${q.toString()}`,
      AwaitResponseSchema,
      { token, signal },
    );
  }

  /**
   * guardStatus returns the workspace's quarantined agents and recent
   * incidents; any member may ask.
   */
  guardStatus(workspace: string, token: string): Promise<GuardStatusResponse> {
    return this.#call('GET', `/v1/workspaces/${enc(workspace)}/guard`, GuardStatusResponseSchema, {
      token,
    });
  }

  /**
   * guardAction posts a guard action about the named agent and returns the
   * incident recorded: quarantine and release are for humans only, requests
   * (ask the humans for a quarantine) for humans and watchers; others get
   * unauthorized.
   */
  guardAction(
    workspace: string,
    token: string,
    action: 'quarantine' | 'release' | 'requests',
    body: { name: string; reason?: string | undefined },
  ): Promise<Incident> {
    return this.#call('POST', `/v1/workspaces/${enc(workspace)}/guard/${action}`, IncidentSchema, {
      token,
      body,
    });
  }

  /**
   * auditConversations lists every conversation of the workspace, for humans
   * and watchers.
   */
  auditConversations(workspace: string, token: string): Promise<AuditConversationsResponse> {
    return this.#call(
      'GET',
      `/v1/workspaces/${enc(workspace)}/audit/conversations`,
      AuditConversationsResponseSchema,
      { token },
    );
  }

  /**
   * auditConversation reads one thread of the workspace without being a
   * participant and without marking anything read.
   */
  auditConversation(
    workspace: string,
    token: string,
    conversationId: string,
  ): Promise<ConversationResponse> {
    return this.#call(
      'GET',
      `/v1/workspaces/${enc(workspace)}/audit/conversations/${enc(conversationId)}`,
      ConversationResponseSchema,
      { token },
    );
  }

  /**
   * auditFeed returns the workspace's messages after since (absent: none, only
   * the cursor of the newest), at most limit, long-polling up to waitS seconds
   * (the hub caps one request at 25 s) while nothing is new; signal aborts the
   * request.
   */
  auditFeed(
    workspace: string,
    token: string,
    input: { since?: string | undefined; limit: number; waitS: number },
    signal?: AbortSignal,
  ): Promise<AuditFeedResponse> {
    const q = new URLSearchParams({ limit: String(input.limit), wait_s: String(input.waitS) });
    if (input.since) q.set('since', input.since);
    return this.#call(
      'GET',
      `/v1/workspaces/${enc(workspace)}/audit/messages?${q.toString()}`,
      AuditFeedResponseSchema,
      { token, signal },
    );
  }

  /**
   * ackDelivery reports a delivery transition, used after a channel
   * notification was emitted.
   */
  async ackDelivery(
    messageId: string,
    agentId: string,
    token: string,
    state: DeliveryState,
    via: DeliveryVia,
  ): Promise<void> {
    await this.#call('POST', `/v1/deliveries/${enc(messageId)}/${enc(agentId)}`, EmptySchema, {
      token,
      body: { state, via },
    });
  }

  /**
   * subscribeEvents opens the agent's SSE stream and calls onEvent for every
   * parsed HubEvent; when the stream ends or fails it reconnects after an
   * exponential backoff (backoffMs doubling to maxBackoffMs) resuming from the
   * last event id, until stop() is called. onConnect fires per successful
   * connection, onError per failure.
   */
  subscribeEvents(agentId: string, token: string, options: SubscribeOptions): EventSubscription {
    const controller = new AbortController();
    let stopped = false;
    let lastEventId: string | undefined;
    let backoff = options.backoffMs ?? 500;
    const maxBackoff = options.maxBackoffMs ?? 10_000;

    const run = async (): Promise<void> => {
      while (!stopped) {
        try {
          const headers: Record<string, string> = {
            authorization: `Bearer ${token}`,
            accept: 'text/event-stream',
          };
          if (lastEventId) headers['last-event-id'] = lastEventId;
          const res = await this.#fetch(`${this.baseUrl}/v1/agents/${enc(agentId)}/events`, {
            headers,
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw await this.#toError(res);
          backoff = options.backoffMs ?? 500;
          options.onConnect?.();
          for await (const frame of readFrames(res.body)) {
            if (frame.id) lastEventId = frame.id;
            if (frame.data === undefined) continue;
            const parsed = HubEventSchema.safeParse(frame.data);
            if (parsed.success) options.onEvent(parsed.data, frame.id);
          }
        } catch (err) {
          if (stopped) return;
          options.onError?.(err);
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(maxBackoff, backoff * 2);
      }
    };
    void run();
    return {
      stop() {
        stopped = true;
        controller.abort();
      },
    };
  }

  /**
   * #call performs one hub request and returns the response body validated by
   * schema; it is the single path every route method goes through.
   *
   * The request is sent with method to baseUrl plus path; options.token becomes
   * a Bearer authorization header, options.body is JSON-encoded with a
   * content-type header, and options.signal is passed to fetch. A fetch failure
   * rejects with HubApiError hub_unavailable (hint pointing at hub.log) unless
   * the signal was aborted, in which case the original error propagates. A
   * non-2xx response rejects with the HubApiError built by #toError. A 204 or
   * empty body is parsed as undefined, so schema must accept it for such
   * routes; a body that fails schema rejects with hub_unavailable whose
   * extra.issues lists the validation problems.
   */
  async #call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: ZodType<T>,
    options: { token?: string | undefined; body?: unknown; signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      const init: RequestInit = { method, headers };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      if (options.signal) init.signal = options.signal;
      res = await this.#fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      if (options.signal?.aborted) throw err;
      throw new HubApiError(
        'hub_unavailable',
        `cannot reach the agent-link hub at ${this.baseUrl}`,
        {
          hint: 'the hub is started automatically by the edge; check hub.log in the data directory',
        },
      );
    }
    if (!res.ok) throw await this.#toError(res);
    if (res.status === 204) return schema.parse(undefined);
    const text = await res.text();
    const parsed = schema.safeParse(text === '' ? undefined : JSON.parse(text));
    if (!parsed.success) {
      throw new HubApiError(
        'hub_unavailable',
        `unexpected response from the hub for ${method} ${path}`,
        {
          extra: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        },
      );
    }
    return parsed.data;
  }

  /**
   * Turns a non-OK hub response into the HubApiError the caller throws.
   *
   * The body is read as JSON and parsed with ApiErrorSchema. When it is a
   * protocol error body, the error, message and hint become the fields of the
   * HubApiError and every other body field lands in extra. When the body is
   * missing, not JSON or does not match the schema, the error is synthesized
   * from the HTTP status: 'unauthorized' for 401 and 403, 'hub_unavailable' for
   * anything else, with the message "hub answered <status>". In both cases
   * status carries the HTTP status. Consumes the response body; never throws.
   */
  async #toError(res: Response): Promise<HubApiError> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const parsed = ApiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { error, message, hint, ...extra } = parsed.data;
      return new HubApiError(error, message, { hint, extra, status: res.status });
    }
    return new HubApiError(
      res.status === 401 || res.status === 403 ? 'unauthorized' : 'hub_unavailable',
      `hub answered ${res.status}`,
      {
        status: res.status,
      },
    );
  }
}

/** enc URL-encodes a path segment. */
function enc(value: string): string {
  return encodeURIComponent(value);
}

/** SseFrame is a parsed SSE frame. */
export interface SseFrame {
  id?: string;
  event?: string;
  data?: unknown;
}

/**
 * readFrames yields parsed SSE frames from a response body stream, splitting on
 * blank lines and ignoring comment-only blocks.
 */
export async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const frame = parseFrame(block);
      if (frame) yield frame;
    }
  }
}

/**
 * parseFrame parses one SSE block into id, event and JSON data; returns
 * undefined for a block with only comments.
 */
export function parseFrame(block: string): SseFrame | undefined {
  const frame: SseFrame = {};
  let seen = false;
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line.trim() === '') continue;
    seen = true;
    if (line.startsWith('id:')) frame.id = line.slice(3).trim();
    else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      try {
        frame.data = JSON.parse(line.slice(5).trim());
      } catch {
        frame.data = undefined;
      }
    }
  }
  return seen ? frame : undefined;
}
