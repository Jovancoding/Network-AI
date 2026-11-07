---
description: Check the Network-AI federated token budget and recent spend
---

Report the Network-AI federated budget using the loaded MCP tools:

1. Call `budget_status` (overall and per-agent if arguments were given: $ARGUMENTS).
2. Summarize: ceiling, spent, remaining, and top spenders.
3. If spend exceeds 80% of the ceiling, call it out prominently and suggest either raising the ceiling (`budget_reset` / config) or pausing non-critical agents.
