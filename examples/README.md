# network-ai · Examples

Runnable demos that show the core features in under five minutes.  
All three examples work without an API key.

```
examples/
  01-hello-swarm.ts      ← three agents passing work through a blackboard
  02-fsm-pipeline.ts     ← FSM governance (state-based access control)
  03-parallel-agents.ts  ← parallel agents + four synthesis strategies
```

## Prerequisites

```bash
# from the repo root
npm install
```

> **ts-node** is already in devDependencies, so `npx ts-node` works out of the box.

---

## 01 · Hello Swarm

Three agents (Researcher → Analyst → Reporter) pass tasks through a shared
blackboard.  Shows identity-verified writes, namespace scoping, and
orchestrator-managed delegation.

```bash
npx ts-node examples/01-hello-swarm.ts
```

**What you'll see**
- Each agent writes to a different namespace (`research:`, `analysis:`, `report:`)
- Agents only see blackboard keys their namespace allows
- Final report assembled from the blackboard snapshot

---

## 02 · FSM Pipeline

A `JourneyFSM` governs a six-state workflow.  The demo walks through the full
pipeline while deliberately triggering blocked transitions and blocked tool
calls so you can see the compliance layer in action.

```bash
npx ts-node examples/02-fsm-pipeline.ts
```

**What you'll see**
- ✅ Authorized agents acting in the right state
- 🚫 Unauthorized agents blocked
- 🔒 Unauthorized tool calls blocked (even for authorized agents)
- 📋 Full transition history with timestamps

---

## 03 · Parallel Agents

Three specialist agents run concurrently (sentiment, keywords, summary) and
their results are combined using all four built-in synthesis strategies:
`merge`, `vote`, `chain`, and `first-success`.

```bash
npx ts-node examples/03-parallel-agents.ts
```

**What you'll see**
- All three agents execute in parallel (~320 ms wall-clock)
- Side-by-side output for each synthesis strategy
- A second run demonstrating blackboard result caching (near-zero latency)

---

## Running all examples

```bash
npx ts-node examples/01-hello-swarm.ts
npx ts-node examples/02-fsm-pipeline.ts
npx ts-node examples/03-parallel-agents.ts
```

---

## Next steps

| Goal | Starting point |
|------|---------------|
| Connect a real LLM | Replace any `registerHandler` body with an `openai.chat.completions.create(...)` call |
| Add a framework adapter | `import { LangChainAdapter } from 'network-ai'` and pass it to `createSwarmOrchestrator` |
| Persist the blackboard | The blackboard already writes to `swarm-blackboard.md` — inspect it after a run |
| Add type-safe agents | Copy an adapter from `adapters/custom-adapter.ts` and extend `BaseAdapter` |
