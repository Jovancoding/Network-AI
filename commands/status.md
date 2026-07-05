---
description: Show Network-AI swarm status — blackboard snapshot, budget, and recent audit activity
---

Give me a concise Network-AI swarm status report. Use the Network-AI MCP tools that are already loaded:

1. Call `blackboard_list` to get the current shared-state keys, then `blackboard_read` on the most relevant ones (status, task, fsm keys).
2. Call `budget_status` for the federated token budget.
3. Call `audit_query` for the 10 most recent audit entries.

Summarize in three short sections: **Blackboard**, **Budget**, **Recent activity**. Flag anything unusual (denied permissions, budget near ceiling, stale state).
