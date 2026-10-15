# agent-link v1 Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build agent-link v1 as specified in `docs/history/specs/2026-10-10-agent-link-v1-design.md`: a Claude Code plugin whose per-session MCP edge talks to a local hub so agents in one workspace can hold conversations, with channel push delivery and hook fallback.

**Architecture:** Three TypeScript packages in a pnpm workspace. `protocol` holds shared zod schemas and ids. `hub` (`agent-linkd`) is a plain Node HTTP server over `node:sqlite` with an in-process event bus feeding SSE streams and long polls. `edge` (`agent-link-edge`) is a stdio MCP server on `@modelcontextprotocol/sdk` 1.x that proxies tools to the hub, emits `notifications/claude/channel`, and doubles as the hook binary. `plugin/` packages it for Claude Code.

**Tech Stack:** Node 24 (native TypeScript execution, `node:sqlite`, `node --test`), pnpm workspaces, TypeScript 5.9 for typecheck only, zod 4, `@modelcontextprotocol/sdk` ^1.32 (pinned to 1.x per decision D3), eslint 10 + typescript-eslint 8 + prettier 3.

**No build step.** Node 24 strips types natively, so every package's `exports` points at `./src/index.ts`, the bins are `src/bin.ts` with the shebang `#!/usr/bin/env -S node --no-warnings=ExperimentalWarning`, and workspace packages resolve to each other's sources in tests and at runtime alike. `tsc` runs with `noEmit` for typechecking. Source must stay within erasable syntax (`erasableSyntaxOnly`): no enums, no parameter properties, no namespaces.

**Conventions for every task** (the project's code-quality rules):

- TDD: write the failing test, run it, implement, run it, commit. Tests live next to the source as `*.test.ts` and run with `pnpm test` (`node --test`), no build step.
- Source files import siblings with the `.ts` extension; Node requires it and `allowImportingTsExtensions` lets `tsc` accept it.
- Every exported function, type and module gets a doc comment as it is written; before each commit, check that no doc comment describes code that changed.
- Each task maps to a task in the project's tracker (created in Task 0); set it in progress when starting and record outcome and effort when finishing.

---

## File structure

```
agent-link/
  package.json                     workspace root: scripts build/test/lint/typecheck/link:bins
  pnpm-workspace.yaml
  tsconfig.base.json               strict, NodeNext, allowImportingTsExtensions, rewriteRelativeImportExtensions, erasableSyntaxOnly
  eslint.config.js, .prettierrc
  .agent-link.json                 { "workspace": "agent-link" }
  .claude-plugin/marketplace.json  lists ./plugin
  packages/protocol/src/
    ids.ts                         newId(prefix) → prefix + 20 base32 chars
    schemas.ts                     zod: Expectation, AgentKind, Agent, Message, Conversation, tool inputs, API bodies, ErrorCode
    index.ts
  packages/hub/src/
    config.ts                      data dir, port, hub.json path (env + defaults)
    store/db.ts                    openDatabase(path) → DatabaseSync with schema applied (idempotent)
    store/agents.ts                AgentStore: register (reclaim by session / collision suffix), bySession, byToken, peers, setOffline, touch
    store/conversations.ts         ConversationStore: create, addParticipants, participants, get, listForAgent
    store/messages.ts              MessageStore: send (deliveries), inbox, markRead, pendingForHook, openExpectations, messagesAfter
    events.ts                      EventBus: subscribe(agentId, fn), publish(agentId, event), waitFor(agentId, pred, timeoutMs)
    http.ts                        tiny router + json(), readJson(), HttpError, bearer auth helper
    routes/sessions.ts             POST /v1/sessions, GET /v1/sessions/:id/pending, GET /v1/sessions/:id/open, POST /v1/sessions/:id/end
    routes/agents.ts               POST /v1/agents, DELETE /v1/agents/:id, GET /v1/workspaces/:ws/agents
    routes/messages.ts             POST /v1/messages, GET /v1/agents/:id/inbox, GET /v1/agents/:id/conversations, GET /v1/conversations/:id
    routes/stream.ts               GET /v1/agents/:id/events (SSE), GET /v1/agents/:id/await, POST /v1/deliveries/:msg/:agent
    presence.ts                    PresenceTracker: stream connected/disconnected, 30 s grace → setOffline
    server.ts                      createHub({ dbPath, port }) → { listen(), close(), url } wiring stores, bus, routes
    bin.ts                         agent-linkd: parse env, open db, listen, write hub.json, handle SIGTERM
  packages/edge/src/
    config.ts                      resolveHubUrl(), resolveWorkspace(cwd) walking up for .agent-link.json
    hub-client.ts                  HubClient: typed fetch per route; subscribeEvents(agentId, token, onEvent) with Last-Event-ID + backoff
    hub-launcher.ts                ensureHub(url): health → spawn agent-linkd detached under lock → wait
    session.ts                     EdgeSession: holds agentId, token, name, workspace after register
    tools.ts                       tool list (name, description, inputSchema from zod) and dispatch(name, args, ctx)
    channel.ts                     renderChannelContent(event), emitChannel(server, event)
    mcp-server.ts                  createEdgeServer(deps) → Server with capabilities, instructions, handlers
    hook.ts                        runHook(event, stdinJson) → { stdout, exitCode } for session-start | pending | stop | session-end
    bin.ts                         agent-link-edge: argv[2]==='hook' ? hook : stdio MCP server
  plugin/
    .claude-plugin/plugin.json
    .mcp.json                      { "agent-link": { "type": "stdio", "command": "agent-link-edge" } }
    hooks/hooks.json
    skills/agent-link/SKILL.md
    commands/human.md
  scripts/e2e.ts                   hub + three in-process edges, asserts the scenario from spec §10
  README.md
```

---

### Task 0: Tracker tasks for the build

- [ ] Create one tracker task per Task 1–14 below, each linked to the component it affects (plugin, edge, hub, protocol), with dependencies following the task order.
- [ ] Store the design spec alongside the project.

### Task 1: Repository scaffold

**Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.gitignore`, `.agent-link.json`, `packages/{protocol,hub,edge}/package.json`, `packages/*/tsconfig.json`, `README.md`

- [ ] **Step 1:** Root `package.json` with scripts `typecheck` (`pnpm -r run typecheck`), `test` (`node --test --no-warnings=ExperimentalWarning 'packages/*/src/**/*.test.ts' 'scripts/**/*.test.ts'`), `test:coverage`, `lint` (`eslint . && prettier --check .`), `format`, `link:bins` (`pnpm --filter @agent-link/hub --filter @agent-link/edge exec pnpm link --global`), `e2e`. Dev deps: typescript ~5.9, @types/node ^24, eslint ^10, @eslint/js ^10, typescript-eslint ^8, prettier ^3.
- [ ] **Step 2:** `tsconfig.base.json`: `module/moduleResolution NodeNext`, `target ES2023`, `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit: true`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedModules`. Each package `tsconfig.json` extends it with `rootDir: src` and includes `src/**/*.ts` (tests included, so eslint's project service sees them). `scripts/tsconfig.json` likewise.
- [ ] **Step 3:** Package manifests. `@agent-link/protocol` (deps: `zod ^4`; `exports: { ".": "./src/index.ts" }`). `@agent-link/hub` (deps: protocol `workspace:*`, zod; `bin: { "agent-linkd": "src/bin.ts" }`; `exports` also `"./bin": "./src/bin.ts"`). `@agent-link/edge` (deps: protocol, hub `workspace:*`, `@modelcontextprotocol/sdk ^1.32.0 <2`, zod; `bin: { "agent-link-edge": "src/bin.ts" }`). Each with `"typecheck": "tsc -p ."` only.
- [ ] **Step 3b:** `eslint.config.js`: `@eslint/js` recommended + `typescript-eslint` recommendedTypeChecked with `projectService`; rules `consistent-type-imports`, `explicit-module-boundary-types`, and `no-floating-promises` with `allowForKnownSafeCalls` for `node:test`'s `test/describe/it/suite`.
- [ ] **Step 4:** `.agent-link.json` → `{ "workspace": "agent-link" }`. `.gitignore`: `node_modules`, `dist`, `*.db`.
- [ ] **Step 5:** `pnpm install`; add a trivial `packages/protocol/src/index.test.ts` asserting `1 + 1 === 2`; run `pnpm test` → 1 pass; `pnpm typecheck` and `pnpm lint` clean.
- [ ] **Step 6:** Commit: `chore: scaffold pnpm workspace with protocol, hub, edge packages`.

### Task 2: Protocol package

**Files:** `packages/protocol/src/ids.ts`, `schemas.ts`, `index.ts`, tests beside them.

- [ ] **Step 1:** Test `ids.test.ts`: `newId('ag')` matches `/^ag_[0-9a-z]{20}$/`; 1000 ids are unique.
- [ ] **Step 2:** Implement `newId(prefix)` with `crypto.randomBytes(13)` → base32 lowercase, sliced to 20.
- [ ] **Step 3:** Test `schemas.test.ts`: `ExpectationSchema` accepts `reply|none|updates` and rejects `ack`; `SendInputSchema` requires `body` and `to` unless `conversation_id` is given (refine); `RegisterInputSchema` requires `session_id`, `name`, `description`, `capabilities`; `MessageBodySchema` is `z.string().min(1).max(65536)` so an empty body is `invalid_message`; `ErrorCode` enumerates `hub_unavailable, not_registered, session_required, workspace_required, peer_not_found, not_participant, invalid_message, unauthorized, not_found`.
- [ ] **Step 4:** Implement schemas (names end with `Schema`, types exported with `z.infer`): `AgentKindSchema`, `AgentStatusSchema`, `AgentSchema` (id, name, workspace, description, capabilities, kind, status, last_seen), `PeerSchema` (Agent minus status/session), `MessageSchema` (id, conversation_id, from, to: string[], body, expectation, final, in_reply_to nullable, created_at), `ConversationSchema`, `ConversationSummarySchema` (id, subject, participants, last_message_at, unread, open_for_me: `{ message_id, from, expectation, created_at }[]`), tool inputs (`RegisterInput`, `SendInput`, `ReplyInput`, `AwaitInput`, `InboxInput`, `ConversationInput`, `ConversationsInput`), API bodies (`RegisterRequest` = RegisterInput plus `cwd` so the hub can upsert the `session` row, `RegisterResponse { agent, token, peers }`, `SendRequest`, `SendResponse { message_id, conversation_id, delivered_to, offline }`, `PendingResponse { messages, open_replies }`, `SessionUpsertRequest`), `DeliveryStateSchema`, `DeliveryViaSchema`, `HubEventSchema` (discriminated: `message` with message + subject + participants; `peer` with name + joined|left), `ApiErrorSchema { error, message, hint? }`. Body limit 64 KiB as `.max(65536)`.
- [ ] **Step 5:** Run tests, document the module and each exported symbol, commit `feat(protocol): ids and shared schemas`.

### Task 3: Hub store — database and agents

**Files:** `packages/hub/src/store/db.ts`, `store/agents.ts`, tests.

- [ ] **Step 1:** Test `db.test.ts`: `openDatabase(':memory:')` returns a `DatabaseSync` where `sqlite_master` lists tables `agent, conversation, participant, message, delivery, session`; calling it twice on the same file is idempotent.
- [ ] **Step 2:** Implement `openDatabase(path)`: `new DatabaseSync(path)`, `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`, then `CREATE TABLE IF NOT EXISTS` for the six tables exactly as spec §4, plus:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS agent_online_name ON agent(workspace, name) WHERE status = 'online';
  CREATE INDEX IF NOT EXISTS delivery_to_state ON delivery(to_agent, state);
  CREATE INDEX IF NOT EXISTS message_conv_created ON message(conversation_id, created_at);
  ```
  Timestamps are ISO strings; booleans are 0/1.
- [ ] **Step 3:** Test `agents.test.ts` (each test opens a fresh in-memory db):
  - register creates an online agent with hashed token (`sha256`), returns `{ agent, token }`; `byToken(token)` finds it; `byToken('x')` is undefined.
  - two registrations with the same name in one workspace → second gets `name-2`; same name in another workspace → no suffix.
  - register with a `session_id` that already maps to an agent reclaims it: same id, new token (old token no longer resolves), updated description, name unchanged and not suffixed.
  - `peers(workspace, excludeId)` returns only online agents of that workspace, excluding the caller.
  - `setOffline(id)` makes it disappear from peers and frees the name: a new register with that name gets no suffix.
  - `bySession(session_id)` returns the agent; `touch(id)` bumps `last_seen`.
- [ ] **Step 4:** Implement `AgentStore` class over the db with prepared statements. Suffix loop: try `name`, `name-2`, `name-3`… until the partial unique index is satisfied (check with a SELECT, not by catching constraint errors).
- [ ] **Step 5:** Tests pass; docs written; commit `feat(hub): sqlite schema and agent store`.

### Task 4: Hub store — conversations, messages, deliveries

**Files:** `packages/hub/src/store/conversations.ts`, `store/messages.ts`, tests.

- [ ] **Step 1:** Test `conversations.test.ts`: `create(workspace, createdBy, subject, participantIds)` returns id and stores participants; `addParticipants` is idempotent (adding an existing participant is a no-op); `isParticipant`; `get` returns conversation with participant names; `messages(conversationId, since?)` returns the thread, or only messages after the `since` message id.
- [ ] **Step 2:** Implement `ConversationStore`.
- [ ] **Step 3:** Test `messages.test.ts`, with three online agents a, b, c in workspace `w` and d in `other`:
  - `send({from: a, toNames: ['b'], body, expectation: 'reply'})` creates a conversation with participants {a, b}, one message, one delivery row for b in `queued`; result `delivered_to: ['b']`, `offline: []`.
  - `send` to `'*'` reaches b and c, not d.
  - `send` with `toNames: ['d']` throws `peer_not_found` with `online: ['b','c']`; nothing written.
  - `send` with `toNames: ['b','zzz']` throws and writes nothing (transaction).
  - reply: `send({from: b, conversationId, body})` goes to a (not b), sets `in_reply_to` to a's latest message, and marks a's earlier messages in the conversation `read` for b (`via: 'reply'`). This is the single code path behind both the `reply` and `send`-with-`conversation_id` tools.
  - reclaim: after `setOffline(a)`, a message sent into the conversation leaves a `queued` row for a; `register` with a's `session_id` reclaims a (status online, `offline_at` null) and `inbox(a)` returns that message. If another online agent took a's name meanwhile, the reclaimed a gets the suffixed name.
  - reply when a is offline: written, `delivered_to: []`, `offline: ['a']`, delivery row `queued`.
  - `send` with `conversationId` and `toNames: ['c']` adds c as participant; later replies reach c too.
  - sender not a participant of `conversationId` → `not_participant`.
  - `inbox(b, unreadOnly)` returns queued/notified messages for b and marks them `read` via `inbox`.
  - `pendingForHook(b, now)`: returns `queued` messages and marks them `notified` (`notified_at = now`, `nag_count = 0`, `via hook`); a `notified` message with `notified_at` older than 60 s and `nag_count < 2` is returned again with `notified_at` reset and `nag_count + 1`; after two nags it is not returned; a `read` message is never returned. The rule always applies; there is no flag.
  - `openReplies(b)`: messages with `expectation reply` addressed to b in conversations where b has not posted since; empty after b replies. `openUpdates(a)`: `updates` messages addressed to a until a posts `final: true`.
  - `messagesAfter(agentId, { conversationId?, afterMessageId?, afterTime? })` returns messages addressed to the agent from others, used by await.
  - `markRead(agentId, messageIds, via)`.
  - `listForAgent(agentId)` returns summaries with `unread` count and `open_for_me`.
- [ ] **Step 4:** Implement `MessageStore` with `db.exec('BEGIN')`/`COMMIT`/`ROLLBACK` around `send`. `to` names in a returned message are resolved from participants other than the sender at send time and stored as JSON in a `to_names` column added to `message` (update `db.ts` schema and its test).
- [ ] **Step 5:** Tests pass; docs written; commit `feat(hub): conversation and message stores with delivery state`.

### Task 5: Hub HTTP — router, sessions, agents

**Files:** `packages/hub/src/http.ts`, `events.ts`, `routes/sessions.ts`, `routes/agents.ts`, `server.ts`, tests.

- [ ] **Step 1:** Test `http.test.ts`: `Router` matches `GET /v1/agents/:id/inbox` extracting params; unknown → 404 JSON `{ error: 'not_found' }`; `readJson` rejects bodies over 1 MiB; `HttpError(409, 'peer_not_found', msg, extra)` renders to `{ error, message, ...extra }`.
- [ ] **Step 2:** Implement `http.ts` (no framework; `node:http`), `events.ts` (`EventEmitter`-based bus keyed by agent id, with `waitFor(agentId, timeoutMs)` resolving on the first publish or `undefined` on timeout).
- [ ] **Step 3:** Test `server.test.ts` using `createHub({ dbPath: ':memory:', port: 0 })` and `fetch`:
  - `GET /v1/health` → 200 `{ ok: true, version, pid }`.
  - `POST /v1/sessions {session_id, cwd, workspace_hint}` → 200 `{ session, agent: null }`; after registering, the same call returns the agent.
  - `POST /v1/agents` → 201 `{ agent, token, peers }`; registering a second with the same session reclaims (same id); missing `workspace` and no hint → 400 `workspace_required`.
  - `GET /v1/workspaces/w/agents` with a's bearer → peers; with b's token from another workspace → 403; no token → 401.
  - `DELETE /v1/agents/:id` → 204 and the agent leaves peers; wrong token → 401. `POST /v1/sessions/:id/end` does the same without a token.
  - Re-registering with the same `session_id` after `DELETE` brings the agent back online with the same id.
  - `GET /v1/sessions/:id/pending` returns `{ messages: [], open_replies: [] }` for a session with no agent (200, empty) so hooks never fail.
  - `GET /v1/sessions/:id/open` returns `{ agent: { name, kind }, open_replies }` for a registered session and `{ agent: null, open_replies: [] }` for an unknown one. (Its read-only guarantee is asserted in Task 6 once messages exist.)
  - Registering a second agent in the workspace publishes a `peer joined` event on the bus for the first agent (subscribe to `hub.bus` directly in this test); `DELETE` publishes `peer left`.
- [ ] **Step 4:** Implement routes and `createHub`. `createHub(opts)` returns `{ listen(), close(), url, stores: { agents, conversations, messages }, bus, presence, closeStreams() }`; the extra handles exist for tests (Tasks 6, 8, 10) and the bin uses only `listen`/`close`/`url`. Auth helper: `requireAgent(req, params.id)` resolves bearer → agent, 401 if missing/invalid, 403 if `agent.id !== params.id`. `POST /v1/agents` upserts the `session` row from `session_id` + `cwd`, then on register or reclaim publishes `{ type: 'peer', name, description, kind, event: 'joined' }` to every other online agent in the workspace; `DELETE` and the session `end` route publish `left`.
- [ ] **Step 5:** Tests pass; docs; commit `feat(hub): http server with session and agent routes`.

### Task 6: Hub HTTP — messages, inbox, conversations, await, SSE

**Files:** `packages/hub/src/routes/messages.ts`, `routes/stream.ts`, tests.

- [ ] **Step 1:** Test `messages.routes.test.ts`: `POST /v1/messages` as a to `['b']` with `expectation: reply` → 201 `SendResponse`; b's `GET /v1/agents/b/inbox` returns it and a second call with `unread_only` returns nothing; `GET /v1/conversations/:id` as c (not participant) → 403; `GET /v1/conversations/:id?since=<first message id>` returns only later messages and marks only those `read`; `GET /v1/agents/b/conversations` lists the thread with `open_for_me` holding a's message, while a's listing has `open_for_me: []`; body of 70 000 chars or an empty body → 400 `invalid_message`; `GET /v1/sessions/<b's session>/open` reports the open reply and leaves the delivery `queued` (check `GET /v1/sessions/<b>/pending` afterwards still returns the message). Reclaim: `DELETE /v1/agents/b`, a replies into the conversation (`offline: ['b']`), b re-registers with the same `session_id`, and b's inbox now contains the reply (spec §4).
- [ ] **Step 2:** Implement `routes/messages.ts`; on every successful send, `bus.publish(recipientId, { type: 'message', ... })` for each recipient (online or not; nobody listens for offline ones).
- [ ] **Step 3:** Test `stream.test.ts`:
  - `GET /v1/agents/b/events` with bearer: response is `text/event-stream`; a send from a produces an SSE frame `id: <seq>\nevent: message\ndata: {...}`; a registration of c in the workspace produces an `event: peer` frame on b's stream; the hub also emits a `: keepalive` comment every 15 s (`createHub({ keepaliveMs })`, set to 50 ms in the test).
  - A fresh connect (no `Last-Event-ID`) first replays every delivery for b still `queued`, oldest first; a reconnect with `Last-Event-ID` skips those at or before it (query the store, not an in-memory log).
  - `GET /v1/agents/b/await?timeout_s=1` returns `{ messages: [], timed_out: true }` after ~1 s; with a concurrent send it returns the message within 100 ms and marks it `read` via `await`; an unread message that already exists before the call returns immediately; `conversation=` and `message=` filters behave as spec §5 (`message=` only returns messages created after that message).
  - `timeout_s` above 25 → clamped to 25.
  - `POST /v1/deliveries/:msg/:agent {state:'notified', via:'channel'}` transitions `queued → notified`; `read → notified` is ignored (200, no change).
- [ ] **Step 4:** Implement `routes/stream.ts`. SSE: set headers, write replay frames, subscribe to bus, unsubscribe on `req.on('close')`, call `presence.connected/disconnected` (Task 7 supplies it; stub an interface now). Event `id` is the message's `created_at` + id so `Last-Event-ID` can be used as `afterTime`.
- [ ] **Step 5:** Tests pass; docs; commit `feat(hub): message routes, long-poll await and SSE stream`.

### Task 7: Hub binary, config and presence

**Files:** `packages/hub/src/config.ts`, `presence.ts`, `bin.ts`, tests.

- [ ] **Step 1:** Test `config.test.ts`: defaults to `~/.local/share/agent-link` and port 8790; `AGENT_LINK_DATA_DIR`, `AGENT_LINK_PORT`, `XDG_DATA_HOME` override; `hubJsonPath(dataDir)`.
- [ ] **Step 2:** Test `presence.test.ts` with fake timers (`node:test` `mock.timers`): `disconnected(agentId)` schedules `setOffline` after 30 s; `connected(agentId)` within the grace cancels it; agent stays online.
- [ ] **Step 3:** Implement both; wire presence into `createHub` and the SSE route; `createHub` gains a `graceMs` option for tests (`keepaliveMs` already exists from Task 6).
- [ ] **Step 4:** `bin.ts`: read config, `mkdir -p` data dir, `createHub({ dbPath, port })`, `listen`, write `hub.json { url, pid, started_at }`, log one line to stderr, on `SIGTERM`/`SIGINT` close and remove `hub.json`. Test by spawning `node packages/hub/src/bin.ts` with a temp data dir and port 0? Port 0 cannot be discovered from outside, so bin prints the URL to stdout as its first line; the test reads it, hits `/v1/health`, sends SIGTERM, asserts `hub.json` is gone.
- [ ] **Step 5:** Tests pass; `pnpm build` produces `packages/hub/dist/bin.js` with a shebang (`#!/usr/bin/env node` as the first line of `bin.ts`); docs; commit `feat(hub): agent-linkd binary, config and presence grace`.

### Task 8: Edge — config, hub client, launcher

**Files:** `packages/edge/src/config.ts`, `hub-client.ts`, `hub-launcher.ts`, tests.

- [ ] **Step 1:** Test `config.test.ts`: `resolveWorkspace('/tmp/x/a/b')` finds `.agent-link.json` in `/tmp/x` (create a temp tree); returns `undefined` when none; `AGENT_LINK_WORKSPACE` wins. `resolveHubUrl()` order: `AGENT_LINK_HUB` env → `$XDG_CONFIG_HOME/agent-link/config.json` `hub` → `hub.json` in data dir → `http://127.0.0.1:8790`.
- [ ] **Step 2:** Test `hub-client.test.ts` against an in-process hub from `@agent-link/hub` `createHub` (workspace dependency `devDependencies`): `register`, `peers`, `send`, `inbox`, `conversation`, `conversations`, `await`, `ackDelivery`, `unregister`, `sessionUpsert`, `sessionPending`, `sessionEnd` all return parsed, schema-validated results; an API error becomes a thrown `HubApiError { code, message, hint, extra }`; `subscribeEvents(agentId, token, onEvent)` yields the event for a send, and after the hub closes the stream the client reconnects with `Last-Event-ID` and receives a message sent during the gap (test closes the stream by calling the hub's `closeStreams()` test hook).
- [ ] **Step 3:** Implement with global `fetch`; SSE parsing by hand (split on `\n\n`, parse `id:`, `event:`, `data:`); backoff 500 ms doubling to 10 s; `stop()` aborts.
- [ ] **Step 4:** Test `hub-launcher.test.ts`: `ensureHub(url)` returns immediately when `/v1/health` answers; when nothing listens on a loopback URL it spawns the hub binary (inject `spawnHub` function for the test; assert it was called once even when two `ensureHub` calls race, via the lock file in a temp data dir) and resolves once health answers; for a non-loopback URL it never spawns and throws `hub_unavailable`.
- [ ] **Step 5:** Implement: spawn `process.execPath` with the hub bin path resolved via `import.meta.resolve('@agent-link/hub/bin')` (ESM; `require.resolve` is unavailable), converted with `fileURLToPath`, `detached: true`, stdio to `<dataDir>/hub.log`, `unref()`; lock via `fs.openSync(lockPath, 'wx')` with stale-lock removal after 10 s; poll health every 100 ms up to 5 s.
- [ ] **Step 6:** Tests pass; docs; commit `feat(edge): hub client, config resolution and hub launcher`.

### Task 9: Edge — MCP server and tools

**Files:** `packages/edge/src/session.ts`, `tools.ts`, `mcp-server.ts`, tests.

- [ ] **Step 1:** Test `mcp-server.test.ts`: build `createEdgeServer({ client, session, cwd })` and connect it to an SDK `Client` over `InMemoryTransport.createLinkedPair()` against an in-process hub.
  - `listTools` returns exactly `register, peers, send, reply, await, inbox, conversation, conversations, unregister`, each with a JSON schema generated by `z.toJSONSchema`.
  - Server capabilities (from `client.getServerCapabilities()`) include `experimental['claude/channel']` and `tools`; `client.getInstructions()` is a non-empty string.
  - Calling `send` before `register` returns a tool result whose text is `{ error: 'not_registered', hint }` with `isError: true`.
  - `register` without `session_id` → `{ error: 'session_required' }`. With it → result contains `agent_id`, `name`, `workspace: 'agent-link'` (from a temp cwd with `.agent-link.json`), `peers`.
  - Two edges (two client/server pairs) registered as `architect` and `designer`: `designer.send({to:['architect'], body, expectation:'reply'})` → `architect.inbox()` shows it → `architect.reply(...)` → `designer.await({ conversation_id, timeout_s: 2 })` returns the reply. `peers` from a third edge in workspace `other` is empty.
  - `await` with `timeout_s: 1` and no traffic returns `timed_out: true` and the server sent at least one `notifications/progress` when the request carried a `progressToken` (set `_meta.progressToken` on the call).
  - With the client pointed at a closed port and `ensureHub` injected as a no-op, `peers` returns `{ error: 'hub_unavailable', hint }` rather than throwing.
- [ ] **Step 2:** Implement `session.ts` (plain state holder), `tools.ts` (array of `{ name, description, schema, handler }`; handler returns a JSON-serialisable object; errors from `HubApiError` map to `{ error, message, hint, ...extra }`), `mcp-server.ts`:
  ```ts
  const server = new Server({ name: 'agent-link', version }, {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: INSTRUCTIONS,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => { ... });
  ```
  Tool results: `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError }`. `await` slices the hub long-poll in 25 s chunks, and between slices sends `extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: n } })` when a token is present, honouring `extra.signal`.
  `INSTRUCTIONS` (used by the channel too): explains the `<channel source="agent-link" …>` tag, that the agent must use `reply` (not transcript output) to answer a peer, that `expectation: reply` means someone is waiting, and that `peers` lists who is available.
- [ ] **Step 3:** Tests pass; docs; commit `feat(edge): stdio MCP server exposing the agent-link tools`.

### Task 10: Edge — channel emission

**Files:** `packages/edge/src/channel.ts`, test; modify `mcp-server.ts` to start the subscription after `register`.

- [ ] **Step 1:** Test `channel.test.ts`: `renderChannelContent(event)` for a `message` event yields `"architect → you (expects reply) in conversation cv_… «Caching»:\n\n<body>"` and for `expectation none` says `(fyi)`, `updates` says `(wants updates)`, `final` appends `[final]`; for a `peer joined` event yields `"peer joined: reviewer — <description>"`.
      In `mcp-server.test.ts` add: after `designer` registers, the client registers `client.setNotificationHandler(ChannelNotificationSchema, …)` for method `notifications/claude/channel` (define the zod schema locally in the test) and asserts that a send from `architect` produces one notification with `params.content` containing the body and `params.meta` `{ conversation_id, message_id, from: 'architect', expectation: 'reply', final: 'false' }` (all meta values strings), and that the hub delivery is then `notified` via `channel` (check through `inbox({ unread_only: false })` or a store peek on the in-process hub).
- [ ] **Step 2:** Implement: `emitChannel(server, event)` calls `server.notification({ method: 'notifications/claude/channel', params: { content, meta } })` then `client.ackDelivery(message_id, agent_id, 'notified', 'channel')`. In `mcp-server.ts`, after a successful `register`, stop any existing subscription and start `client.subscribeEvents(...)` with the new token (re-register issues a new token, so the old stream must be replaced), routing events to `emitChannel`; `peer left` events are ignored.
- [ ] **Step 3:** Tests pass; docs; commit `feat(edge): emit Claude channel notifications for inbound messages`.

### Task 11: Edge — hook subcommands and binary

**Files:** `packages/edge/src/hook.ts`, `bin.ts`, tests.

- [ ] **Step 1:** Test `hook.test.ts` calling `runHook(event, input, { client, cwd })` directly against an in-process hub:
  - `session-start` with `{ session_id, cwd, source: 'startup' }` → stdout JSON `{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }` whose text contains the session id, the default workspace and the instruction to call `register`; and the hub now has a `session` row. With `source: 'resume'` and an existing agent for the session → text names the agent and says to register again to reclaim.
  - `pending` (used for UserPromptSubmit and PostToolUse) with a queued message → `{ hookSpecificOutput: { hookEventName: <event>, additionalContext: '1 agent-link message waiting: architect (expects reply) «Caching»: …  Call inbox or conversation to read.' } }` and the delivery is now `notified` via `hook`; a second call → empty stdout, exit 0; `tool_name: 'mcp__plugin_agent-link_agent-link__inbox'` → empty stdout without touching the hub (assert via a spy on the client).
  - `stop` reads `GET /v1/sessions/:id/open` (never `pending`, so it does not consume a message's first surfacing): with an open reply expectation → `{ decision: 'block', reason }` and the delivery is still `queued` afterwards; with `stop_hook_active: true` → empty without calling the hub; for a `kind: human` agent → empty; with nothing open → empty.
  - `session-end` → hub agent offline.
  - Any event when the hub is unreachable (client pointed at a closed port) → empty stdout, exit 0, within 1 s.
- [ ] **Step 2:** Implement `runHook` returning `{ stdout, exitCode }`; the event name for `pending` is taken from the input's `hook_event_name`.
- [ ] **Step 3:** `bin.ts`: `#!/usr/bin/env node`; if `argv[2] === 'hook'`, read all stdin, `runHook(argv[3], JSON.parse(stdin))`, write stdout, exit; else `ensureHub(url)` then `createEdgeServer(...)` connected to `StdioServerTransport`. Test: spawn `node packages/edge/src/bin.ts hook pending` with JSON on stdin and a hub URL env pointing at a closed port → exit 0, empty stdout.
- [ ] **Step 4:** Tests pass; `pnpm build`; docs; commit `feat(edge): hook subcommands and agent-link-edge binary`.

### Task 12: Plugin packaging, skill, human command

**Files:** `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/hooks/hooks.json`, `plugin/skills/agent-link/SKILL.md`, `plugin/commands/human.md`, `.claude-plugin/marketplace.json`, `README.md`.

- [ ] **Step 1:** `plugin.json`: name `agent-link`, description, version `0.1.0`, author `muralx`. `marketplace.json` lists the plugin (`plugins: [{ name: 'agent-link', source: './plugin', category: 'development' }]`).
- [ ] **Step 2:** `.mcp.json`: `{ "agent-link": { "type": "stdio", "command": "agent-link-edge" } }`.
- [ ] **Step 3:** `hooks.json`:
  ```json
  {
    "hooks": {
      "SessionStart": [
        {
          "hooks": [
            { "type": "command", "command": "agent-link-edge hook session-start", "timeout": 5 }
          ]
        }
      ],
      "UserPromptSubmit": [
        {
          "hooks": [{ "type": "command", "command": "agent-link-edge hook pending", "timeout": 5 }]
        }
      ],
      "PostToolUse": [
        {
          "matcher": "",
          "hooks": [{ "type": "command", "command": "agent-link-edge hook pending", "timeout": 5 }]
        }
      ],
      "Stop": [
        { "hooks": [{ "type": "command", "command": "agent-link-edge hook stop", "timeout": 5 }] }
      ],
      "SessionEnd": [
        {
          "hooks": [
            { "type": "command", "command": "agent-link-edge hook session-end", "timeout": 5 }
          ]
        }
      ]
    }
  }
  ```
  Verify the exact shape against https://code.claude.com/docs/en/hooks.md (plugin `hooks/hooks.json` uses the same shape as settings `hooks`).
- [ ] **Step 4:** `SKILL.md` (frontmatter `name: agent-link`, `description: Use when this session should talk to other Claude Code agents in the same workspace — registering, finding peers, asking, answering, broadcasting, and reading hook notices about waiting messages`): register first with a specific name and a description that says what you can be asked; check `peers` before asking; choose `expectation` honestly (`reply` only when you will act on the answer; `updates` for delegated work; `none` otherwise); answer with `reply` inside the conversation, never by writing in your transcript; when a hook says messages are waiting, read them with `inbox` at the next natural point and answer open `reply` expectations before stopping; `await` only when you cannot proceed without the answer; a `kind: human` peer is the person at the keyboard, ask for decisions not for things you can resolve.
- [ ] **Step 5:** `commands/human.md` (frontmatter `description: Act as the human relay for this workspace`, `argument-hint: [name]`): instructions from spec §7, name `$1` or `$USER`, kind `human`; show every inbound message verbatim with from, conversation id, expectation; never answer for the human; relay typed replies with `reply`; stay idle otherwise.
- [ ] **Step 6:** `README.md`: what it is, install (`pnpm install && pnpm build && pnpm link:bins`, `claude plugin marketplace add <checkout>`, `claude plugin install agent-link@agent-link`), launching with channels (`claude --dangerously-load-development-channels plugin:agent-link@agent-link`), the human relay, where the database and logs live, and the SDK 1.x pin (D3).
- [ ] **Step 7:** Validate JSON files with `node -e`; `claude plugin validate plugin/` if the subcommand exists; commit `feat(plugin): Claude Code plugin packaging, skill and human relay command`.

### Task 13: End-to-end script and final verification

**Files:** `scripts/e2e.ts`, `scripts/e2e.test.ts`.

- [ ] **Step 1:** `scripts/e2e.ts` exports `runScenario()` and runs it when executed directly: start a hub on an ephemeral port with a temp db; create three edges via `createEdgeServer` + `InMemoryTransport` + SDK `Client` with cwd temp dirs whose `.agent-link.json` put `architect` and `designer` in `ws1` and `stranger` in `ws2`; assert: `stranger.peers()` is empty and `designer.peers()` is `[architect]`; designer asks with `reply`, architect sees a channel notification, replies, designer `await` gets it, and architect's `conversations` shows no open reply; broadcast from architect reaches designer only; architect `unregister` → designer `send` to architect → `peer_not_found`; a reply from designer into the old conversation succeeds with `offline: ['architect']`. Print `e2e ok`.
- [ ] **Step 2:** `scripts/e2e.test.ts` imports `runScenario` so `pnpm test` covers it.
- [ ] **Step 3:** Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `node --test --experimental-test-coverage` to confirm ≥ 90 % line coverage on `packages/hub/src` and `packages/edge/src`; fix gaps.
- [ ] **Step 4:** Check that every exported symbol and module has a current doc comment; document anything missing or stale.
- [ ] **Step 5:** Commit `test: end-to-end scenario and coverage`. Update the tracker: each build task with outcome and effort; write a "Manual test protocol" describing the two-window plus human-relay check a person will run.

### Task 14: Manual verification handoff (human)

Not automated. Install per README, open two Claude Code windows in `<checkout>` with `--dangerously-load-development-channels plugin:agent-link@agent-link`, register `architect` and `designer`, have designer ask architect something while architect is mid-task, confirm the channel tag appears in architect's window and the reply reaches designer; run `/agent-link:human` in a third window and have an agent ask the human a question. Record findings as fix tasks.
