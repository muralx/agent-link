## Purpose

HTTP route groups of the hub, one module per concern (sessions, agents, messages, stream, guard, audit), each exporting a register function that adds its routes to the shared Router from HubDeps. testkit.ts is the HTTP-level test helper.
