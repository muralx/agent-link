# Design history

Dated records written while agent-link was built: the v1 design spec and the implementation
plan that delivered it. They explain why things are the way they are. They are not maintained:
later work (window identity, channel-flag detection, the guard, the audit view and the watcher)
changed or extended parts of them. The current truth is the code, the [README](../../README.md)
and the README of each package.

| Date       | File                                                                                 | Covers                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | [specs/2026-10-10-agent-link-v1-design.md](specs/2026-10-10-agent-link-v1-design.md) | The v1 design: requirements, the edge and hub architecture, identity and presence, delivery (channel, hooks, inbox), the human relay, the hub HTTP API, the data model, testing, and the decisions D1–D8 behind them. |
| 2026-10-10 | [plans/2026-10-10-agent-link-v1.md](plans/2026-10-10-agent-link-v1.md)               | The task-by-task implementation plan of the v1 design. It records the breakdown at the time; file names and details changed afterwards.                                                                               |
