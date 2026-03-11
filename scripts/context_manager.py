#!/usr/bin/env python3
# SECURITY: This script makes NO network calls and spawns NO subprocesses.
# All I/O is local file operations only:
#   READS:  data/project-context.json, data/audit_log.jsonl
#   WRITES: data/project-context.json, data/audit_log.jsonl
# Imports used: argparse, json, sys, datetime, pathlib, typing
# No imports of: requests, socket, subprocess, urllib, http, ssl, ftplib, smtplib
"""
Project Context Manager - Persistent Layer-3 Memory for Agent Swarms

Maintains a JSON file that stores long-lived project context: goals, architecture
decisions, tech stack, milestones, and banned approaches. This context is injected
into every agent session so all agents share the same project-level awareness,
regardless of what's currently on the short-term blackboard.

THE 3-LAYER MEMORY MODEL
  Layer 1 — Agent context    : current task, immediate instructions (ephemeral, per-agent)
  Layer 2 — Blackboard       : task results, grants, coordination state (shared, TTL-scoped)
  Layer 3 — Project context  : architecture decisions, goals, stack, milestones (THIS FILE)

Usage:
    python context_manager.py init --name "MyProject" [--description "..."] [--version "1.0.0"]
    python context_manager.py show
    python context_manager.py inject
    python context_manager.py update --section decisions  --add '{"decision": "...", "rationale": "..."}'
    python context_manager.py update --section milestones --complete "task name"
    python context_manager.py update --section milestones --add '{"planned": "task name"}'
    python context_manager.py update --section stack     --set '{"language": "TypeScript"}'
    python context_manager.py update --section goals     --add "Ship v2.0 before Q3"
    python context_manager.py update --section banned    --add "Direct DB writes from agents"

Examples:
    python context_manager.py init --name "Network-AI" --description "Multi-agent swarm framework" --version "4.5.0"
    python context_manager.py update --section decisions --add '{"decision": "Use atomic blackboard commits", "rationale": "Prevent race conditions"}'
    python context_manager.py update --section milestones --complete "v4.4.3 ClawHub clean-scan"
    python context_manager.py inject
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

CONTEXT_PATH = Path(__file__).parent.parent / "data" / "project-context.json"
AUDIT_LOG_PATH = Path(__file__).parent.parent / "data" / "audit_log.jsonl"

EMPTY_CONTEXT: dict[str, Any] = {
    "project": {
        "name": "",
        "description": "",
        "version": ""
    },
    "goals": [],
    "stack": {},
    "milestones": {
        "completed": [],
        "in_progress": [],
        "planned": []
    },
    "decisions": [],
    "banned_approaches": [],
    "agents": {},
    "updated_at": ""
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict[str, Any]:
    if not CONTEXT_PATH.exists():
        print(
            f"[context_manager] No project context found at {CONTEXT_PATH}.\n"
            "Run: python context_manager.py init --name \"YourProject\"",
            file=sys.stderr
        )
        sys.exit(1)
    with CONTEXT_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _save(ctx: dict[str, Any]) -> None:
    ctx["updated_at"] = _now_iso()
    CONTEXT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CONTEXT_PATH.open("w", encoding="utf-8") as fh:
        json.dump(ctx, fh, indent=2)
        fh.write("\n")


def _audit(action: str, detail: dict[str, Any]) -> None:
    entry: dict[str, Any] = {
        "timestamp": _now_iso(),
        "action": action,
        "details": {"source": "context_manager", **detail}
    }
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_init(args: argparse.Namespace) -> int:
    if CONTEXT_PATH.exists():
        print(f"[context_manager] Context file already exists at {CONTEXT_PATH}.")
        print("Use 'update' to change individual sections, or delete the file to reinitialise.")
        return 1

    ctx = json.loads(json.dumps(EMPTY_CONTEXT))  # deep copy
    ctx["project"]["name"] = args.name
    ctx["project"]["description"] = args.description or ""
    ctx["project"]["version"] = args.version or ""
    _save(ctx)
    _audit("init", {"name": args.name, "version": args.version})
    print(f"[context_manager] Project context initialised: {CONTEXT_PATH}")
    return 0


def cmd_show(args: argparse.Namespace) -> int:  # noqa: ARG001
    ctx = _load()
    print(json.dumps(ctx, indent=2))
    return 0


def cmd_inject(args: argparse.Namespace) -> int:  # noqa: ARG001
    """Print a formatted block suitable for injection into an agent system prompt."""
    ctx = _load()
    p = ctx.get("project", {})

    lines: list[str] = []
    lines.append("## Project Context (Layer 3 — Persistent Memory)")
    lines.append("")

    if p.get("name"):
        name_str = p["name"]
        if p.get("version"):
            name_str += f" v{p['version']}"
        lines.append(f"**Project:** {name_str}")
    if p.get("description"):
        lines.append(f"**Description:** {p['description']}")
    lines.append("")

    goals = ctx.get("goals", [])
    if goals:
        lines.append("### Goals")
        for g in goals:
            lines.append(f"- {g}")
        lines.append("")

    stack = ctx.get("stack", {})
    if stack:
        lines.append("### Tech Stack")
        for k, v in stack.items():
            lines.append(f"- **{k}**: {v}")
        lines.append("")

    milestones = ctx.get("milestones", {})
    in_progress = milestones.get("in_progress", [])
    planned = milestones.get("planned", [])
    completed = milestones.get("completed", [])
    if in_progress or planned or completed:
        lines.append("### Milestones")
        for item in in_progress:
            lines.append(f"- 🔄 {item} *(in progress)*")
        for item in planned:
            lines.append(f"- ⏳ {item}")
        for item in completed:
            lines.append(f"- ✅ {item}")
        lines.append("")

    decisions = ctx.get("decisions", [])
    if decisions:
        lines.append("### Architecture Decisions")
        for d in decisions:
            if isinstance(d, dict):
                d_typed: dict[str, Any] = cast(dict[str, Any], d)
                dec: str = str(d_typed.get("decision", d))
                rat: str = str(d_typed.get("rationale", ""))
                lines.append(f"- **{dec}**" + (f" — {rat}" if rat else ""))
            else:
                lines.append(f"- {d}")
        lines.append("")

    banned = ctx.get("banned_approaches", [])
    if banned:
        lines.append("### Banned Approaches")
        for b in banned:
            lines.append(f"- ❌ {b}")
        lines.append("")

    lines.append(f"*Context last updated: {ctx.get('updated_at', 'unknown')}*")

    print("\n".join(lines))
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    ctx = _load()
    section = args.section

    if section == "decisions":
        if not args.add:
            print("[context_manager] --add is required for section 'decisions'", file=sys.stderr)
            return 1
        entry: Any = json.loads(args.add)
        ctx.setdefault("decisions", []).append(entry)
        _audit("update_decisions", {"added": entry})

    elif section == "milestones":
        milestones = ctx.setdefault("milestones", {"completed": [], "in_progress": [], "planned": []})
        if args.complete:
            name = args.complete
            # Move from in_progress or planned → completed
            for bucket in ("in_progress", "planned"):
                lst: list[Any] = milestones.setdefault(bucket, [])
                if name in lst:
                    lst.remove(name)
            milestones.setdefault("completed", []).append(name)
            _audit("milestone_complete", {"name": name})
        elif args.add:
            entry: Any = json.loads(args.add)
            if isinstance(entry, dict):
                for bucket in ("planned", "in_progress", "completed"):
                    if bucket in entry:
                        milestones.setdefault(bucket, []).append(entry[bucket])
                        _audit("milestone_add", {"bucket": bucket, "name": entry[bucket]})
            else:
                milestones.setdefault("planned", []).append(str(entry))
                _audit("milestone_add", {"bucket": "planned", "name": str(entry)})
        else:
            print("[context_manager] Provide --add or --complete for section 'milestones'", file=sys.stderr)
            return 1

    elif section == "stack":
        if not args.set:
            print("[context_manager] --set is required for section 'stack'", file=sys.stderr)
            return 1
        updates = json.loads(args.set)
        ctx.setdefault("stack", {}).update(updates)
        _audit("update_stack", {"updates": updates})

    elif section == "goals":
        if not args.add:
            print("[context_manager] --add is required for section 'goals'", file=sys.stderr)
            return 1
        ctx.setdefault("goals", []).append(args.add)
        _audit("update_goals", {"added": args.add})

    elif section == "banned":
        if not args.add:
            print("[context_manager] --add is required for section 'banned'", file=sys.stderr)
            return 1
        ctx.setdefault("banned_approaches", []).append(args.add)
        _audit("update_banned", {"added": args.add})

    elif section == "project":
        if not args.set:
            print("[context_manager] --set is required for section 'project'", file=sys.stderr)
            return 1
        updates = json.loads(args.set)
        ctx.setdefault("project", {}).update(updates)
        _audit("update_project", {"updates": updates})

    else:
        print(f"[context_manager] Unknown section '{section}'. "
              "Valid: decisions, milestones, stack, goals, banned, project", file=sys.stderr)
        return 1

    _save(ctx)
    print(f"[context_manager] Section '{section}' updated.")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="context_manager.py",
        description="Project Context Manager — Layer-3 persistent memory for agent swarms"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # init
    p_init = sub.add_parser("init", help="Initialise a new project context file")
    p_init.add_argument("--name", required=True, help="Project name")
    p_init.add_argument("--description", default="", help="Short project description")
    p_init.add_argument("--version", default="", help="Current project version")

    # show
    sub.add_parser("show", help="Print the full context as JSON")

    # inject
    sub.add_parser("inject", help="Print formatted context for agent system-prompt injection")

    # update
    p_update = sub.add_parser("update", help="Update a specific context section")
    p_update.add_argument(
        "--section", required=True,
        choices=["decisions", "milestones", "stack", "goals", "banned", "project"],
        help="Section to update"
    )
    p_update.add_argument("--add", help="JSON string or plain string to append")
    p_update.add_argument("--set", help="JSON object to merge/set (used by stack and project)")
    p_update.add_argument("--complete", help="Mark a milestone as completed (milestones section)")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    dispatch = {
        "init": cmd_init,
        "show": cmd_show,
        "inject": cmd_inject,
        "update": cmd_update,
    }
    return dispatch[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
