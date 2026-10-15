## Purpose

Shared contract between the agent-link hub and edge: id minting and the zod schemas for every tool input, hub API body and SSE event.

Both packages import from here and nowhere else for wire shapes, so a change to a schema is a change to the protocol. It must stay free of I/O and of hub or edge dependencies.
