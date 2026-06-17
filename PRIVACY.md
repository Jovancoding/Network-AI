# Privacy Policy

**Effective date:** 2026-06-17
**Applies to:** Network-AI (the `network-ai` npm package, MCP server, CLI, and Claude Code plugin)

## Summary

Network-AI runs entirely on your own machine. It collects no personal data,
sends no telemetry, and makes no network calls of its own. There is no
account, no sign-in, and no cloud backend operated by the project.

## What we collect

**Nothing.** The Network-AI project does not collect, receive, store, or
transmit any personal data or usage data about you.

## Data the software stores locally

Network-AI persists its operational state to local files on the machine where
you run it. These files never leave your device unless you copy them yourself.
They include:

- `data/audit_log.jsonl` — append-only audit trail of state changes,
  permission grants, and transitions
- `swarm-blackboard.md` and `data/pending_changes/` — shared blackboard state
  and write-ahead-log entries
- `data/active_grants.json`, `data/.signing_key` — permission grants and the
  local token-signing key
- `data/budget_tracking.json`, `data/task_tracking.json`,
  `data/agent_health.json`, `data/project-context.json` — runtime tracking

You own and control these files. Delete them at any time.

## Telemetry

Network-AI ships with telemetry **disabled by default**. The default
`NullTelemetryProvider` performs no collection and makes no outbound calls.
OpenTelemetry support is strictly opt-in and bring-your-own (BYOT): if you
choose to wire in your own OTel SDK via `createOtelHooks()`, spans are sent
**only** to the collector you configure. The Network-AI project never receives
that data.

## Network access

Network-AI makes no outbound HTTP calls of its own — no telemetry, no
call-home, no cloud dependency. Any network activity originates from clients,
adapters, or model providers **you** configure (e.g. an LLM API key you supply
under the bring-your-own-client model). Those services are governed by their
own privacy policies.

## Third-party model providers

When you connect Network-AI to an external agent framework or model provider
(OpenAI, Anthropic, etc.), your prompts and data are handled by that provider
under its terms and privacy policy. Network-AI does not forward that data to
the project or to any party other than the provider you configured.

## Children's privacy

Network-AI is a developer tool and is not directed to children. It collects no
data from anyone.

## Changes to this policy

If this policy changes, the updated version will be published in this file in
the repository, with a revised effective date.

## Contact

Questions about privacy: open an issue at
<https://github.com/Jovancoding/Network-AI/issues> or email
jmarinovic1997@gmail.com.
