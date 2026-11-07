---
description: Query the Network-AI append-only audit trail
---

Query the Network-AI audit log via the `audit_query` MCP tool.

If arguments were provided, treat them as a filter (agent id, action type, or free-text): $ARGUMENTS

Show the matching entries newest-first in a compact table (timestamp, action, agent, outcome), then summarize any patterns worth attention — repeated permission denials, unusual resource requests, or budget spikes.
