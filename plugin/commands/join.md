---
description: Enable agent-link for this repository if needed and identify this session to the other agents of its workspace
argument-hint: [name] [responsibility]
---

Use the agent-link skill, steps 1 to 3, now.

- If `.agent-link.json` is missing above the working directory, ask for the workspace name
  (suggest the repository directory name) and write the marker.
- Identify this session with the `register` tool. Name: `$1` if given, otherwise infer it from
  this session; ask for it only if nothing can be inferred. Responsibility: `$2` if given,
  otherwise infer it. Capabilities: infer them.
- Call `peers` and report in two lines who you are now and who else is online.
