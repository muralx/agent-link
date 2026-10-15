## Purpose

Persistence layer of the hub over one node:sqlite DatabaseSync: db.ts owns the schema, AgentStore, SessionStore, ConversationStore and MessageStore each own their tables, GuardStore owns the incident log and evaluates the guard's sending limits, AuditStore answers the read-only workspace audit queries, and HubError is the shared expected-failure type. Stores know nothing about HTTP; routes call them and publish events.
