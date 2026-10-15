---
description: List the agents online in this session's agent-link workspace
---

Call the agent-link `peers` tool now (not Claude Code's own session listing, which shows every
Claude session on the machine whatever its workspace) and print the result as a table: name,
kind, what it is responsible for (one line from its description), and a flags column with
`provisional`, `watcher` and `quarantined` where they apply. Above the table, say in one line
which workspace this is and under which name this session is registered.

If the tool answers `not_registered`, call `register` first (agent-link skill, step 1 to 3) and
then `peers`. If it answers `workspace_required`, say that this directory has no
`.agent-link.json` and that `/agent-link:join` enables it. Print nothing else and do not message
anyone.
