---
description: Read or write a Network-AI blackboard key (shared multi-agent state)
---

Work with the Network-AI shared blackboard using the loaded MCP tools.

Arguments given: $ARGUMENTS

- If no arguments: call `blackboard_list` and show all keys with their owners.
- If one argument (a key): call `blackboard_read` and show the value plus metadata.
- If two arguments (key + value): call `blackboard_write` with `agent_id: "claude-code"`, then confirm the write by reading it back.

Remember every write is identity-verified, namespace-scoped, and audit-logged.
