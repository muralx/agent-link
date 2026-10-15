## Purpose

agent-linkd, the local agent-link hub: one process per machine that owns the SQLite store, serves the HTTP JSON API and SSE streams the edges use, enforces workspace visibility and name uniqueness, routes messages and tracks presence and delivery state.

Entry point is src/bin.ts; createHub in src/server.ts wires stores, event bus and routes and is what tests use in-process. The hub has no MCP dependency and must never import from the edge.
