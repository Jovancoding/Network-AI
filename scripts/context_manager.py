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
    python context_manager.py inject [--force]
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
    python context_manager.py inject                          # blocked if context has prompt-injection patterns
    python context_manager.py inject --force                  # override block (trusted/CI environments only)
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

def _resolve_data_dir(env: str = "") -> Path:
    """Return the active data directory, scoped to <env> when set."""
    import re as _re, os as _os
    _env = env or _os.environ.get("NETWORK_AI_ENV", "")
    base = Path(__file__).parent.parent / "data"
    if _env:
        if not _re.match(r'^[a-zA-Z0-9_-]+$', _env):
            raise ValueError(f"Invalid NETWORK_AI_ENV value: {_env!r}")
        return base / _env
    return base

_DATA_DIR = _resolve_data_dir()
CONTEXT_PATH = _DATA_DIR / "project-context.json"
AUDIT_LOG_PATH = _DATA_DIR / "audit_log.jsonl"

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


def _validate_context(ctx: dict[str, Any]) -> list[str]:
    """
    Validate the project context file against the expected schema.

    Returns a list of warning strings (empty = clean).
    Checks:
    - Required top-level keys are present
    - String fields are not excessively long (injection/poisoning guard)
    - List entries are strings or dicts, not executable-looking content
    - No obvious prompt-injection patterns in goals, decisions, or banned entries
    """
    import re as _re
    warnings: list[str] = []

    REQUIRED_KEYS = {"project", "goals", "stack", "milestones", "decisions",
                     "banned_approaches", "updated_at"}
    missing = REQUIRED_KEYS - set(ctx.keys())
    if missing:
        warnings.append(f"Missing keys in context file: {', '.join(sorted(missing))}")

    # Field length caps
    project = ctx.get("project", {})
    for field in ("name", "description", "version"):
        val = project.get(field, "")
        if isinstance(val, str) and len(val) > 500:
            warnings.append(f"project.{field} exceeds 500 characters \u2014 consider shortening.")

    # Injection pattern check on free-text list fields
    INJECTION_RE = _re.compile(
        r'ignore\s+(previous|above|prior|all)|override\s+(policy|restriction|rule)|'
        r'system\s*prompt|you\s+are\s+(now|a)|act\s+as\s+(if|a|an)|'
        r'pretend\s+(to|that|you)|bypass\s+(security|check|restriction)|'
        r'disregard\s+(policy|rule)|admin\s+(mode|access|override)|'
        r'\bsudo\b|\bjailbreak\b',
        _re.IGNORECASE,
    )

    def _check_text(label: str, text: str) -> None:
        if INJECTION_RE.search(text):
            warnings.append(
                f"Possible injection pattern detected in {label}: {text[:80]!r}"
            )
        if len(text) > 2000:
            warnings.append(f"{label} entry exceeds 2000 characters \u2014 review before injecting.")

    for i, goal in enumerate(ctx.get("goals", [])):
        if isinstance(goal, str):
            _check_text(f"goals[{i}]", goal)

    for i, dec in enumerate(ctx.get("decisions", [])):
        if isinstance(dec, dict):
            dec_dict = cast(dict[str, object], dec)
            for fld in ("decision", "rationale"):
                fld_val = dec_dict.get(fld)
                if isinstance(fld_val, str):
                    _check_text(f"decisions[{i}].{fld}", fld_val)
        elif isinstance(dec, str):
            _check_text(f"decisions[{i}]", dec)

    for i, banned in enumerate(ctx.get("banned_approaches", [])):
        if isinstance(banned, str):
            _check_text(f"banned_approaches[{i}]", banned)

    return warnings


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
    warnings = _validate_context(ctx)
    if warnings:
        print("[context_manager] VALIDATION WARNINGS — review before injecting:", file=sys.stderr)
        for w in warnings:
            print(f"  ! {w}", file=sys.stderr)
    print(json.dumps(ctx, indent=2))
    return 0


def cmd_inject(args: argparse.Namespace) -> int:
    """Print a formatted block suitable for injection into an agent system prompt."""
    ctx = _load()
    warnings = _validate_context(ctx)
    if warnings:
        print("[context_manager] VALIDATION WARNINGS \u2014 context has potential issues:", file=sys.stderr)
        for w in warnings:
            print(f"  ! {w}", file=sys.stderr)
        if not getattr(args, "force", False):
            print(
                "[context_manager] ERROR: Injection blocked. Context contains potential prompt-injection "
                "content. Use --force to override (only in trusted, controlled environments).",
                file=sys.stderr,
            )
            return 1
        print("[context_manager] --force: proceeding with inject despite warnings.", file=sys.stderr)
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
    p_inject = sub.add_parser("inject", help="Print formatted context for agent system-prompt injection")
    p_inject.add_argument(
        "--force",
        action="store_true",
        help="Proceed with injection even when validation warnings are present (prompt-injection risk — only use in trusted environments)",
    )

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

    # Global --env flag on root parser
    parser.add_argument(
        "--env",
        default="",
        help="Target environment (dev|st|sit|qa|sandbox|preprod|prod). Overrides NETWORK_AI_ENV."
    )

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    # Re-resolve data paths if --env was provided explicitly.
    # Use globals() to avoid Pyright reportConstantRedefinition on uppercase names.
    if args.env:
        _data = _resolve_data_dir(args.env)
        globals()['CONTEXT_PATH'] = _data / "project-context.json"
        globals()['AUDIT_LOG_PATH'] = _data / "audit_log.jsonl"

    dispatch = {
        "init": cmd_init,
        "show": cmd_show,
        "inject": cmd_inject,
        "update": cmd_update,
    }
    return dispatch[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
