#!/usr/bin/env python3
# SECURITY: Local-only. No network access and no child processes.
# All I/O is local file operations only:
#   READS:  <data_dir>/swarm-blackboard.md, <data_dir>/pending_changes/<id>.json,
#           <data_dir>/.blackboard.lock
#   WRITES: <data_dir>/swarm-blackboard.md, <data_dir>/pending_changes/<id>.json,
#           <data_dir>/pending_changes/archive/<id>.<committed|aborted>.json,
#           <data_dir>/.blackboard.lock
#   DELETES: <data_dir>/pending_changes/<id>.json (after archiving it)
#   where <data_dir> is "data/" by default, or "data/<env>/" when NETWORK_AI_ENV
#   is set or --env is passed. <env> must be one of dev|st|sit|qa|sandbox|preprod|prod
#   (anything else is rejected); the directory name comes from that fixed list,
#   never from the caller's input.
# Every write goes through _open_confined(): the file's real parent directory must
# sit inside data/ (or the project root, for --path), and a symlink at the file
# itself is refused (O_NOFOLLOW where the OS provides it). A planted symlink can
# therefore never redirect the lock, pending, archive, or blackboard writes.
# --path controls the blackboard file path only and is validated against the project
# root directory; paths outside the project directory are rejected (CWE-22).
# Lock files and pending-change files always resolve from the active env-scoped
# data directory regardless of --path; only the main blackboard file path is
# affected by --path.
# Imports used: argparse, json, os, re, sys, time, hashlib, datetime, pathlib,
#               typing, contextlib, fcntl (Unix) / msvcrt (Windows) for OS file locks only
# Standard library only; no networking or process-spawning modules are imported.
"""
Shared Blackboard - Agent Coordination State Manager (Atomic Commit Edition)

A markdown-based shared state system for multi-agent coordination.
Stores key-value pairs with optional TTL (time-to-live) expiration.

FEATURES:
  - File Locking: Prevents race conditions in multi-agent environments
  - Staging Area: propose → validate → commit workflow
  - Checked Commits: each commit re-checks, under the lock, that the key has not
    changed since the proposal, then applies that one change; the blackboard
    file is replaced atomically (write to a temp file, then rename)

Usage:
    python blackboard.py write KEY VALUE [--ttl SECONDS]
    python blackboard.py read KEY
    python blackboard.py delete KEY
    python blackboard.py list
    python blackboard.py snapshot
    
    # Atomic commit workflow:
    python blackboard.py propose CHANGE_ID KEY VALUE [--ttl SECONDS]
    python blackboard.py validate CHANGE_ID
    python blackboard.py commit CHANGE_ID
    python blackboard.py abort CHANGE_ID
    python blackboard.py list-pending

Examples:
    python blackboard.py write "task:analysis" '{"status": "running"}'
    python blackboard.py write "cache:data" '{"value": 123}' --ttl 3600
    python blackboard.py read "task:analysis"
    python blackboard.py list
    
    # Safe multi-agent update:
    python blackboard.py propose "chg_001" "order:123" '{"status": "approved"}'
    python blackboard.py validate "chg_001"  # Orchestrator checks for conflicts
    python blackboard.py commit "chg_001"    # Re-check for conflicts, then apply
"""

import argparse
import json
import os
import re
import stat
import sys
import time
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from contextlib import contextmanager

# OS file locks: fcntl on Unix, msvcrt on Windows (both standard library)
_fcntl: Any = None
_msvcrt: Any = None
try:
    import fcntl as _fcntl_import
    _fcntl = _fcntl_import
except ImportError:
    try:
        import msvcrt as _msvcrt_import
        _msvcrt = _msvcrt_import
    except ImportError:
        pass  # FileLock.acquire fails closed if neither is available

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DATA_ROOT = _PROJECT_ROOT / "data"

# The only environments a data/<env>/ directory is used for.
_ENVIRONMENTS = ("dev", "st", "sit", "qa", "sandbox", "preprod", "prod")


def _resolve_data_dir(env: str = "") -> Path:
    """Return data/, or data/<env>/ for one of the documented environments."""
    requested = env or os.environ.get("NETWORK_AI_ENV", "")
    if not requested:
        return _DATA_ROOT
    for name in _ENVIRONMENTS:
        if requested == name:
            return _DATA_ROOT / name  # built from the fixed list, not the input
    raise ValueError(
        f"Unknown environment {requested!r}; expected one of: {', '.join(_ENVIRONMENTS)}"
    )


_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_BINARY = getattr(os, "O_BINARY", 0)


def _require_inside(directory: Path, root: Path) -> None:
    """Refuse `directory` unless, with symlinks resolved, it is `root` or beneath it."""
    real_root = root.resolve()
    real_dir = directory.resolve()
    if real_dir != real_root and real_root not in real_dir.parents:
        raise PermissionError(f"Refusing to write outside {real_root}: {directory}")


def _check_confined(path: Path, root: Path) -> None:
    """Refuse `path` unless its real parent is inside `root` and it is not a symlink."""
    _require_inside(path.parent, root)
    if path.is_symlink():
        raise PermissionError(f"Refusing to write through a symlink: {path}")


def _open_confined(path: Path, flags: int, root: Path = _DATA_ROOT) -> int:
    """Open `path` for writing without leaving `root` or following a symlink."""
    _check_confined(path, root)
    return os.open(path, flags | _O_NOFOLLOW | _O_BINARY, 0o600)


def _write_confined(path: Path, text: str, root: Path = _DATA_ROOT,
                    exclusive: bool = False) -> None:
    """Write `text` to `path` (truncating, or create-only when `exclusive`)."""
    mode = os.O_EXCL if exclusive else os.O_TRUNC
    fd = _open_confined(path, os.O_WRONLY | os.O_CREAT | mode, root)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)


_DATA_DIR = _resolve_data_dir()
BLACKBOARD_PATH = _DATA_DIR / "swarm-blackboard.md"
LOCK_PATH = _DATA_DIR / ".blackboard.lock"
PENDING_DIR = _DATA_DIR / "pending_changes"

# Lock timeout settings
LOCK_TIMEOUT_SECONDS = 10
LOCK_RETRY_INTERVAL = 0.1


class FileLock:
    """
    Cross-platform exclusive file lock (fcntl.flock on Unix, msvcrt.locking on Windows).
    The OS releases it if the holding process dies, so there are no stale locks to guess about.
    """
    
    def __init__(self, lock_path: Path, timeout: float = LOCK_TIMEOUT_SECONDS):
        self.lock_path = lock_path
        self.timeout = timeout
        self.lock_file: Optional[Any] = None
        _check_confined(self.lock_path, _DATA_ROOT)
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
    
    def acquire(self) -> bool:
        """Acquire the lock with timeout."""
        _check_confined(self.lock_path, _DATA_ROOT)
        start_time = time.time()
        
        while True:
            try:
                # No O_TRUNC: opening never truncates a file another process holds locked.
                fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | _O_NOFOLLOW | _O_BINARY, 0o600)
                self.lock_file = os.fdopen(fd, "r+", encoding="utf-8")
                
                if _fcntl is not None:
                    _fcntl.flock(self.lock_file.fileno(), _fcntl.LOCK_EX | _fcntl.LOCK_NB)
                elif _msvcrt is not None:
                    self.lock_file.seek(0)
                    _msvcrt.locking(self.lock_file.fileno(), _msvcrt.LK_NBLCK, 1)
                else:
                    raise RuntimeError("No OS file-locking primitive is available on this platform")
                
                # Holder info is diagnostic only; we own the lock, so rewriting is safe.
                self.lock_file.seek(0)
                self.lock_file.truncate()
                self.lock_file.write(json.dumps({
                    "pid": os.getpid(),
                    "acquired_at": datetime.now(timezone.utc).isoformat()
                }) + "\n")
                self.lock_file.flush()
                return True
                
            except (BlockingIOError, OSError):
                if self.lock_file:
                    self.lock_file.close()
                    self.lock_file = None
                if time.time() - start_time > self.timeout:
                    return False
                time.sleep(LOCK_RETRY_INTERVAL)
    
    def release(self) -> None:
        """Release the lock."""
        if self.lock_file:
            try:
                if _fcntl is not None:
                    _fcntl.flock(self.lock_file.fileno(), _fcntl.LOCK_UN)
                elif _msvcrt is not None:
                    self.lock_file.seek(0)
                    _msvcrt.locking(self.lock_file.fileno(), _msvcrt.LK_UNLCK, 1)
            except OSError:
                pass  # closing the file below releases the lock anyway
            finally:
                self.lock_file.close()
                self.lock_file = None


@contextmanager
def blackboard_lock(lock_path: Path = LOCK_PATH):
    """Context manager for atomic blackboard access."""
    lock = FileLock(lock_path)
    if not lock.acquire():
        raise TimeoutError(
            f"Could not acquire blackboard lock within {LOCK_TIMEOUT_SECONDS}s. "
            "Another agent may be holding it. Retry later."
        )
    try:
        yield
    finally:
        lock.release()


class SharedBlackboard:
    """Markdown-based shared state for agent coordination with atomic commits."""
    
    def __init__(self, path: Path = BLACKBOARD_PATH, data_dir: Optional[Path] = None):
        self.path = path
        # Pending changes and the lock share the blackboard's env-scoped directory.
        self.data_dir = data_dir if data_dir is not None else _DATA_DIR
        self.lock_path = self.data_dir / ".blackboard.lock"
        self.cache: dict[str, dict[str, Any]] = {}
        self.pending_dir = self.data_dir / "pending_changes"
        # Check before mkdir so a symlinked directory cannot create folders elsewhere.
        _require_inside(self.pending_dir / "archive", _DATA_ROOT)
        _check_confined(self.path, _PROJECT_ROOT)
        self.pending_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self._load_from_disk()
    
    def _initialize(self):
        """Create blackboard file if it doesn't exist."""
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            initial_content = f"""# Swarm Blackboard
Last Updated: {datetime.now(timezone.utc).isoformat()}

## Active Tasks
| TaskID | Agent | Status | Started | Description |
|--------|-------|--------|---------|-------------|

## Knowledge Cache
<!-- Cached results from agent operations -->

## Coordination Signals
<!-- Agent availability status -->

## Execution History
<!-- Chronological log of completed tasks -->
"""
            try:
                _write_confined(self.path, initial_content, _PROJECT_ROOT, exclusive=True)
            except FileExistsError:
                pass  # another process created it first
    
    def _load_from_disk(self, strict: bool = False):
        """Replace the in-memory cache with the entries on disk.

        With strict=True a read failure raises instead of keeping the old cache,
        so a locked write never persists stale state.
        """
        try:
            content = self.path.read_text(encoding="utf-8")
            fresh: dict[str, dict[str, Any]] = {}
            
            # Parse Knowledge Cache section
            cache_match = re.search(
                r'## Knowledge Cache\n([\s\S]*?)(?=\n## |$)', 
                content
            )
            
            if cache_match:
                cache_section = cache_match.group(1)
                # Find all entries: ### key\n{json}
                entries = re.findall(
                    r'### (\S+)\n([\s\S]*?)(?=\n### |$)',
                    cache_section
                )
                
                for key, value_str in entries:
                    try:
                        entry = json.loads(value_str.strip())
                        fresh[key] = entry
                    except json.JSONDecodeError:
                        # Skip malformed entries
                        pass
            self.cache = fresh
        except Exception as e:
            if strict:
                raise RuntimeError(f"Failed to load blackboard: {e}") from e
            print(f"Warning: Failed to load blackboard: {e}", file=sys.stderr)
    
    def _persist_to_disk(self):
        """Save entries to the markdown blackboard."""
        sections = [
            "# Swarm Blackboard",
            f"Last Updated: {datetime.now(timezone.utc).isoformat()}",
            "",
            "## Active Tasks",
            "| TaskID | Agent | Status | Started | Description |",
            "|--------|-------|--------|---------|-------------|",
            "",
            "## Knowledge Cache",
        ]
        
        # Clean expired entries and write valid ones
        for key, entry in list(self.cache.items()):
            if self._is_expired(entry):
                del self.cache[key]
                continue
            
            sections.append(f"### {key}")
            sections.append(json.dumps(entry, indent=2))
            sections.append("")
        
        sections.extend([
            "## Coordination Signals",
            "",
            "## Execution History",
        ])
        
        # Readers never see a half-written file: write a temp file, then rename over.
        tmp = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
        tmp.unlink(missing_ok=True)  # a stale tmp (or a planted link) is removed, never followed
        _write_confined(tmp, "\n".join(sections), _PROJECT_ROOT, exclusive=True)
        _check_confined(self.path, _PROJECT_ROOT)
        os.replace(tmp, self.path)  # replaces the directory entry; never writes through a link
    
    def _is_expired(self, entry: dict[str, Any]) -> bool:
        """Check if an entry has expired based on TTL."""
        ttl = entry.get("ttl")
        if ttl is None:
            return False
        
        timestamp = entry.get("timestamp")
        if not timestamp:
            return False
        
        try:
            created = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            elapsed = (now - created).total_seconds()
            return elapsed > ttl
        except Exception:
            return False
    
    def read(self, key: str) -> Optional[dict[str, Any]]:
        """Read an entry from the blackboard (expired entries read as missing)."""
        entry = self.cache.get(key)
        if entry is None or self._is_expired(entry):
            return None
        return entry
    
    def write(self, key: str, value: Any, source_agent: str = "unknown", 
              ttl: Optional[int] = None) -> dict[str, Any]:
        """Write an entry to the blackboard (with file locking)."""
        entry: dict[str, Any] = {
            "key": key,
            "value": value,
            "source_agent": source_agent,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "ttl": ttl,
        }
        
        with blackboard_lock(self.lock_path):
            # Reload to get latest state
            self._load_from_disk(strict=True)
            self.cache[key] = entry
            self._persist_to_disk()
        
        return entry
    
    def delete(self, key: str) -> bool:
        """Delete an entry from the blackboard (with file locking)."""
        with blackboard_lock(self.lock_path):
            self._load_from_disk(strict=True)
            if key in self.cache:
                del self.cache[key]
                self._persist_to_disk()
                return True
        return False
    
    # ========================================================================
    # ATOMIC COMMIT WORKFLOW: propose → validate → commit
    # ========================================================================

    @staticmethod
    def _sanitize_change_id(change_id: str) -> str:
        """
        Sanitize change_id to prevent path traversal attacks.
        Only allows alphanumeric characters, hyphens, underscores, and dots.
        Rejects any path separators or parent directory references.
        """
        if not change_id:
            raise ValueError("change_id must be a non-empty string")
        # Strip whitespace
        sanitized = change_id.strip()
        # Reject path separators and parent directory traversal
        if any(c in sanitized for c in ('/', '\\', '..')):
            raise ValueError(
                f"Invalid change_id '{change_id}': must not contain path separators or '..'"
            )
        # Only allow safe characters: alphanumeric, hyphen, underscore, dot
        if not re.match(r'^[a-zA-Z0-9_\-\.]+$', sanitized):
            raise ValueError(
                f"Invalid change_id '{change_id}': only alphanumeric, hyphen, underscore, and dot allowed"
            )
        return sanitized

    def _safe_pending_path(self, change_id: str, suffix: str = ".pending.json") -> Path:
        """
        Build a pending-file path inside pending_dir without resolving it.

        Symlinks are never followed: the directory's real path must be inside
        data/ (checked by path components, so a sibling such as
        pending_changes_extra/ cannot pass), and the file itself must not be a
        symlink or anything other than a regular file. Every later open uses
        O_NOFOLLOW, so a link planted after this check is refused, not followed.
        """
        safe_id = self._sanitize_change_id(change_id)
        _require_inside(self.pending_dir, _DATA_ROOT)
        target = self.pending_dir / f"{safe_id}{suffix}"
        if target.parent != self.pending_dir or target.name != f"{safe_id}{suffix}":
            raise ValueError(f"Path traversal blocked for change_id '{change_id}'")
        self._pending_exists(target)  # raises on a symlink or non-regular entry
        return target

    @staticmethod
    def _pending_exists(path: Path) -> bool:
        """Whether a pending file exists, without following links. Refuses links and non-files."""
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return False
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            raise PermissionError(f"Refusing pending entry that is not a regular file: {path}")
        return True

    @staticmethod
    def _read_pending(path: Path) -> dict[str, Any]:
        """Read a pending file without following a symlink."""
        fd = os.open(path, os.O_RDONLY | _O_NOFOLLOW | _O_BINARY)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise PermissionError(f"Refusing pending entry that is not a regular file: {path}")
            with os.fdopen(fd, "r", encoding="utf-8") as fh:
                fd = -1
                return json.load(fh)
        finally:
            if fd >= 0:
                os.close(fd)

    @staticmethod
    def _entry_hash(entry: Optional[dict[str, Any]]) -> Optional[str]:
        """Hash of a stored entry, used to detect changes since a proposal."""
        if not entry:
            return None
        return hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()[:16]

    def _archive(self, change_set: dict[str, Any], pending_file: Path, outcome: str) -> None:
        """Move a finished change into pending_changes/archive/. Call with the lock held."""
        safe_id = self._sanitize_change_id(change_set["change_id"])
        archive_dir = self.pending_dir / "archive"
        _require_inside(archive_dir, _DATA_ROOT)
        archive_dir.mkdir(exist_ok=True)
        _write_confined(archive_dir / f"{safe_id}.{outcome}.json", json.dumps(change_set, indent=2))
        # Re-check without following links; unlinking then removes the entry itself, never a link target.
        self._pending_exists(pending_file)
        _require_inside(pending_file.parent, _DATA_ROOT)
        pending_file.unlink()

    def propose_change(self, change_id: str, key: str, value: Any, 
                       source_agent: str = "unknown", ttl: Optional[int] = None,
                       operation: str = "write") -> dict[str, Any]:
        """
        Stage a change without applying it (Step 1 of atomic commit).
        
        The change is written to a .pending file and must be validated
        and committed by the orchestrator before it takes effect.
        """
        pending_file = self._safe_pending_path(change_id)
        
        with blackboard_lock(self.lock_path):
            # Check for duplicate change_id
            if self._pending_exists(pending_file):
                return {
                    "success": False,
                    "error": f"Change ID '{change_id}' already exists. Use a unique ID."
                }
            
            # Base hash from the current on-disk state, for conflict detection
            self._load_from_disk(strict=True)
            current_hash = self._entry_hash(self.cache.get(key))
            
            change_set: dict[str, Any] = {
                "change_id": change_id,
                "operation": operation,  # "write" or "delete"
                "key": key,
                "value": value,
                "source_agent": source_agent,
                "ttl": ttl,
                "proposed_at": datetime.now(timezone.utc).isoformat(),
                "status": "pending",
                "base_hash": current_hash,  # For conflict detection
            }
            
            _write_confined(pending_file, json.dumps(change_set, indent=2), exclusive=True)
        
        return {
            "success": True,
            "change_id": change_id,
            "status": "proposed",
            "pending_file": str(pending_file),
            "message": "Change staged. Run 'validate' then 'commit' to apply."
        }
    
    def validate_change(self, change_id: str) -> dict[str, Any]:
        """
        Validate a pending change for conflicts (Step 2 of atomic commit).
        
        Checks:
        - Change exists
        - No conflicting changes to the same key
        - Base hash matches (data hasn't changed since proposal)
        """
        pending_file = self._safe_pending_path(change_id)
        
        with blackboard_lock(self.lock_path):
            if not self._pending_exists(pending_file):
                return {
                    "valid": False,
                    "error": f"Change '{change_id}' not found. Was it proposed?"
                }
            
            change_set = self._read_pending(pending_file)
            
            if change_set["status"] != "pending":
                return {
                    "valid": False,
                    "error": f"Change is in '{change_set['status']}' state, not 'pending'"
                }
            
            key = change_set["key"]
            base_hash = change_set["base_hash"]
            
            # Check for conflicts: has the key changed since we proposed?
            self._load_from_disk(strict=True)
            current_entry = self.cache.get(key)
            current_hash = self._entry_hash(current_entry)
            
            if base_hash != current_hash:
                return {
                    "valid": False,
                    "conflict": True,
                    "error": f"CONFLICT: Key '{key}' was modified since proposal. "
                             f"Expected hash {base_hash}, got {current_hash}. "
                             "Abort and re-propose with fresh data.",
                    "current_value": current_entry
                }
            
            # Check for other pending changes to the same key
            conflicts: list[str] = []
            for other_file in self.pending_dir.glob("*.pending.json"):
                if other_file.name == pending_file.name:
                    continue
                try:
                    if not self._pending_exists(other_file):
                        continue
                    other_change = self._read_pending(other_file)
                except (PermissionError, OSError, ValueError):
                    continue  # links and non-regular entries are never followed
                if other_change["key"] == key and other_change["status"] in ("pending", "validated"):
                    conflicts.append(other_change["change_id"])
            
            if conflicts:
                return {
                    "valid": False,
                    "conflict": True,
                    "error": f"CONFLICT: Other pending changes affect key '{key}': {conflicts}. "
                             "Resolve conflicts before committing."
                }
            
            # Mark as validated
            change_set["status"] = "validated"
            change_set["validated_at"] = datetime.now(timezone.utc).isoformat()
            _write_confined(pending_file, json.dumps(change_set, indent=2))
        
        return {
            "valid": True,
            "change_id": change_id,
            "key": key,
            "status": "validated",
            "message": "No conflicts detected. Ready to commit."
        }
    
    def commit_change(self, change_id: str) -> dict[str, Any]:
        """
        Apply a validated change (Step 3 of atomic commit).

        Status check, conflict re-check, the write, and archiving all happen
        under one lock, so a change validated against an older value can never
        overwrite a newer one and a change is never applied twice.
        """
        pending_file = self._safe_pending_path(change_id)
        
        with blackboard_lock(self.lock_path):
            if not self._pending_exists(pending_file):
                return {
                    "committed": False,
                    "error": f"Change '{change_id}' not found."
                }
            
            change_set = self._read_pending(pending_file)
            
            if change_set["status"] != "validated":
                return {
                    "committed": False,
                    "error": f"Change must be validated first. Current status: {change_set['status']}"
                }
            
            self._load_from_disk(strict=True)
            key = change_set["key"]
            current_hash = self._entry_hash(self.cache.get(key))
            if current_hash != change_set["base_hash"]:
                return {
                    "committed": False,
                    "conflict": True,
                    "error": f"CONFLICT: Key '{key}' changed after validation "
                             f"(expected {change_set['base_hash']}, got {current_hash}). "
                             "Nothing was written; abort and re-propose with fresh data."
                }
            
            if change_set["operation"] == "delete":
                self.cache.pop(key, None)
            else:
                entry: dict[str, Any] = {
                    "key": key,
                    "value": change_set["value"],
                    "source_agent": change_set["source_agent"],
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "ttl": change_set["ttl"],
                    "committed_from": change_id
                }
                self.cache[key] = entry
            
            self._persist_to_disk()
            
            change_set["status"] = "committed"
            change_set["committed_at"] = datetime.now(timezone.utc).isoformat()
            self._archive(change_set, pending_file, "committed")
        
        return {
            "committed": True,
            "change_id": change_id,
            "key": key,
            "operation": change_set["operation"],
            "message": "Change committed after a conflict re-check."
        }
    
    def abort_change(self, change_id: str) -> dict[str, Any]:
        """Abort a pending change without applying it."""
        pending_file = self._safe_pending_path(change_id)
        
        with blackboard_lock(self.lock_path):
            if not self._pending_exists(pending_file):
                return {
                    "aborted": False,
                    "error": f"Change '{change_id}' not found."
                }
            
            change_set = self._read_pending(pending_file)
            change_set["status"] = "aborted"
            change_set["aborted_at"] = datetime.now(timezone.utc).isoformat()
            self._archive(change_set, pending_file, "aborted")
        
        return {
            "aborted": True,
            "change_id": change_id,
            "key": change_set["key"]
        }
    
    def list_pending_changes(self) -> list[dict[str, Any]]:
        """List all pending changes awaiting commit."""
        pending: list[dict[str, Any]] = []
        _require_inside(self.pending_dir, _DATA_ROOT)
        for pending_file in self.pending_dir.glob("*.pending.json"):
            try:
                if not self._pending_exists(pending_file):
                    continue
                change_set = self._read_pending(pending_file)
            except (PermissionError, OSError, ValueError):
                continue  # links and non-regular entries are skipped, never followed
            pending.append({
                "change_id": change_set["change_id"],
                "key": change_set["key"],
                "operation": change_set["operation"],
                "source_agent": change_set["source_agent"],
                "status": change_set["status"],
                "proposed_at": change_set["proposed_at"]
            })
        return pending
    
    def exists(self, key: str) -> bool:
        """Check if a key exists (and is not expired)."""
        return self.read(key) is not None
    
    def list_keys(self) -> list[str]:
        """List all valid (non-expired) keys."""
        valid_keys: list[str] = []
        for key in list(self.cache.keys()):
            if self.read(key) is not None:
                valid_keys.append(key)
        return valid_keys
    
    def get_snapshot(self) -> dict[str, dict[str, Any]]:
        """Get a snapshot of all valid entries."""
        snapshot: dict[str, dict[str, Any]] = {}
        for key in list(self.cache.keys()):
            entry = self.read(key)
            if entry is not None:
                snapshot[key] = entry
        return snapshot


def main():
    parser = argparse.ArgumentParser(
        description="Shared Blackboard - Agent Coordination State Manager (Atomic Commit Edition)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Commands:
  write KEY VALUE [--ttl SECONDS]     Write a value (with file locking)
  read KEY                            Read a value
  delete KEY                          Delete a key
  list                                List all keys
  snapshot                            Get full snapshot as JSON

Atomic Commit Workflow (for multi-agent safety):
  propose CHANGE_ID KEY VALUE         Stage a change (Step 1)
  validate CHANGE_ID                  Check for conflicts (Step 2)
  commit CHANGE_ID                    Re-check for conflicts, then apply (Step 3)
  abort CHANGE_ID                     Cancel a pending change
  list-pending                        Show all pending changes

Examples:
  %(prog)s write "task:analysis" '{"status": "running"}'
  %(prog)s write "cache:temp" '{"data": [1,2,3]}' --ttl 3600
  
  # Safe multi-agent update:
  %(prog)s propose "chg_001" "order:123" '{"status": "approved"}'
  %(prog)s validate "chg_001"
  %(prog)s commit "chg_001"
"""
    )
    
    parser.add_argument(
        "command",
        choices=["write", "read", "delete", "list", "snapshot", 
                 "propose", "validate", "commit", "abort", "list-pending"],
        help="Command to execute"
    )
    parser.add_argument(
        "key",
        nargs="?",
        help="Key name or Change ID (depending on command)"
    )
    parser.add_argument(
        "value",
        nargs="?",
        help="JSON value (required for write/propose)"
    )
    parser.add_argument(
        "--ttl",
        type=int,
        help="Time-to-live in seconds (for write/propose)"
    )
    parser.add_argument(
        "--agent",
        default="cli",
        help="Source agent ID (for write/propose)"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON"
    )
    parser.add_argument(
        "--path",
        type=Path,
        default=BLACKBOARD_PATH,
        help="Path to blackboard file (must be inside the project directory)",
    )
    parser.add_argument(
        "--env",
        default="",
        help="Target environment (dev|st|sit|qa|sandbox|preprod|prod). Overrides NETWORK_AI_ENV."
    )
    
    args = parser.parse_args()
    # One env-scoped data dir drives the blackboard, pending changes, and lock.
    _data = _resolve_data_dir(args.env) if args.env else _DATA_DIR
    if args.env:
        args.path = _data / "swarm-blackboard.md"

    # Validate --path against the project root to prevent path traversal (CWE-22).
    # Resolving symlinks before comparison ensures traversal via symlinks is also blocked.
    _project_root = Path(__file__).parent.parent.resolve()
    try:
        args.path.resolve().relative_to(_project_root)
    except ValueError:
        print(
            f"Error: --path must be inside the project directory ({_project_root}). "
            f"Got: {args.path.resolve()}",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        bb = SharedBlackboard(args.path, data_dir=_data)

        if args.command == "write":
            if not args.key or not args.value:
                print("Error: write requires KEY and VALUE", file=sys.stderr)
                sys.exit(1)
            
            try:
                value = json.loads(args.value)
            except json.JSONDecodeError:
                value = args.value
            
            entry = bb.write(args.key, value, args.agent, args.ttl)
            
            if args.json:
                print(json.dumps(entry, indent=2))
            else:
                print(f"✅ Written: {args.key} (with lock)")
                if args.ttl:
                    print(f"   TTL: {args.ttl} seconds")
        
        elif args.command == "read":
            if not args.key:
                print("Error: read requires KEY", file=sys.stderr)
                sys.exit(1)
            
            entry = bb.read(args.key)
            
            if entry is None:
                if args.json:
                    print("null")
                else:
                    print(f"❌ Key not found or expired: {args.key}")
                sys.exit(1)
            
            if args.json:
                print(json.dumps(entry, indent=2))
            else:
                print(f"📖 {args.key}:")
                print(f"   Value: {json.dumps(entry.get('value'))}")
                print(f"   Source: {entry.get('source_agent')}")
                print(f"   Timestamp: {entry.get('timestamp')}")
                if entry.get('ttl'):
                    print(f"   TTL: {entry['ttl']} seconds")
        
        elif args.command == "delete":
            if not args.key:
                print("Error: delete requires KEY", file=sys.stderr)
                sys.exit(1)
            
            if bb.delete(args.key):
                print(f"✅ Deleted: {args.key}")
            else:
                print(f"❌ Key not found: {args.key}")
                sys.exit(1)
        
        elif args.command == "list":
            keys = bb.list_keys()
            
            if args.json:
                print(json.dumps(keys, indent=2))
            else:
                if keys:
                    print(f"📋 Blackboard keys ({len(keys)}):")
                    for key in sorted(keys):
                        entry = bb.read(key)
                        ttl_info = f" [TTL: {entry['ttl']}s]" if entry and entry.get('ttl') else ""
                        print(f"   • {key}{ttl_info}")
                else:
                    print("📋 Blackboard is empty")
        
        elif args.command == "snapshot":
            snapshot = bb.get_snapshot()
            print(json.dumps(snapshot, indent=2))
        
        # === ATOMIC COMMIT COMMANDS ===
        
        elif args.command == "propose":
            if not args.key or not args.value:
                print("Error: propose requires CHANGE_ID and KEY VALUE", file=sys.stderr)
                print("Usage: propose CHANGE_ID KEY VALUE", file=sys.stderr)
                sys.exit(1)
            
            # Parse: propose CHANGE_ID KEY VALUE (key is actually change_id, value is "KEY VALUE")
            parts = args.value.split(" ", 1)
            if len(parts) < 2:
                print("Error: propose requires CHANGE_ID KEY VALUE", file=sys.stderr)
                sys.exit(1)
            
            change_id = args.key
            actual_key = parts[0]
            actual_value_str = parts[1] if len(parts) > 1 else "{}"
            
            try:
                actual_value = json.loads(actual_value_str)
            except json.JSONDecodeError:
                actual_value = actual_value_str
            
            result = bb.propose_change(change_id, actual_key, actual_value, args.agent, args.ttl)
            
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                if result["success"]:
                    print(f"📝 Change PROPOSED: {change_id}")
                    print(f"   Key: {actual_key}")
                    print(f"   Status: pending validation")
                    print(f"   Next: run 'validate {change_id}'")
                else:
                    print(f"❌ Proposal FAILED: {result['error']}")
                    sys.exit(1)
        
        elif args.command == "validate":
            if not args.key:
                print("Error: validate requires CHANGE_ID", file=sys.stderr)
                sys.exit(1)
            
            result = bb.validate_change(args.key)
            
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                if result["valid"]:
                    print(f"✅ Change VALIDATED: {args.key}")
                    print(f"   Key: {result['key']}")
                    print(f"   No conflicts detected")
                    print(f"   Next: run 'commit {args.key}'")
                else:
                    print(f"❌ Validation FAILED: {result['error']}")
                    sys.exit(1)
        
        elif args.command == "commit":
            if not args.key:
                print("Error: commit requires CHANGE_ID", file=sys.stderr)
                sys.exit(1)
            
            result = bb.commit_change(args.key)
            
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                if result["committed"]:
                    print(f"🎉 Change COMMITTED: {args.key}")
                    print(f"   Key: {result['key']}")
                    print(f"   Operation: {result['operation']}")
                else:
                    print(f"❌ Commit FAILED: {result['error']}")
                    sys.exit(1)
        
        elif args.command == "abort":
            if not args.key:
                print("Error: abort requires CHANGE_ID", file=sys.stderr)
                sys.exit(1)
            
            result = bb.abort_change(args.key)
            
            if args.json:
                print(json.dumps(result, indent=2))
            else:
                if result["aborted"]:
                    print(f"🚫 Change ABORTED: {args.key}")
                else:
                    print(f"❌ Abort FAILED: {result['error']}")
                    sys.exit(1)
        
        elif args.command == "list-pending":
            pending = bb.list_pending_changes()
            
            if args.json:
                print(json.dumps(pending, indent=2))
            else:
                if pending:
                    print(f"📋 Pending changes ({len(pending)}):")
                    for p in pending:
                        status_icon = "🟡" if p["status"] == "pending" else "🟢"
                        print(f"   {status_icon} {p['change_id']}: {p['operation']} '{p['key']}'")
                        print(f"      Agent: {p['source_agent']} | Status: {p['status']}")
                else:
                    print("📋 No pending changes")
    
    except TimeoutError as e:
        print(f"🔒 LOCK TIMEOUT: {e}", file=sys.stderr)
        sys.exit(1)
    except PermissionError as e:
        print(f"Refused: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
