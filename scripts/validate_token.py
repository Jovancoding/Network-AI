#!/usr/bin/env python3
# SECURITY: This script makes NO network calls and spawns NO subprocesses.
# All I/O is local file operations only:
#   READS:  data[/<env>]/active_grants.json, data[/<env>]/.signing_key
#   WRITES: none
# Imports used: argparse, json, sys, hmac, hashlib, datetime, pathlib, typing
# No imports of: requests, socket, subprocess, urllib, http, ssl, ftplib, smtplib
"""
Validate Grant Token

Check if a permission grant token is valid and not expired.

Usage:
    python validate_token.py TOKEN

Example:
    python validate_token.py grant_a1b2c3d4e5f6
"""

import argparse
import hashlib
import hmac
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

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

GRANTS_FILE = _resolve_data_dir() / "active_grants.json"


def _load_signing_key() -> "Optional[bytes]":
    """
    Load the local HMAC-SHA256 signing key used by check_permission.py.
    Returns None if the key file does not exist or cannot be read.
    """
    key_file = GRANTS_FILE.parent / ".signing_key"
    if not key_file.exists():
        return None
    try:
        return bytes.fromhex(key_file.read_text().strip())
    except (ValueError, OSError):
        return None


def _verify_grant_sig(grant: "dict[str, Any]") -> "Optional[bool]":
    """
    Verify the HMAC-SHA256 signature stored in a grant record.

    Returns:
      True  — signature present and valid
      False — signature present but invalid (tampered)
      None  — no signature (pre-v5.5.2 token) or key unavailable
    """
    stored_sig = grant.get("_sig")
    if not stored_sig:
        return None  # Backward-compatible: unsigned token from before v5.5.2
    key = _load_signing_key()
    if key is None:
        return None  # Key not present — cannot verify; treat as unverified
    payload = "|".join([
        grant.get("token", ""),
        grant.get("agent_id", ""),
        grant.get("resource_type", ""),
        grant.get("scope") or "",
        grant.get("expires_at", ""),
        grant.get("granted_at", ""),
    ])
    expected = hmac.new(key, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, stored_sig)


def validate_token(token: str) -> dict[str, Any]:
    """Validate a grant token and return its details."""
    if not GRANTS_FILE.exists():
        return {
            "valid": False,
            "reason": "No grants file found"
        }
    
    try:
        grants = json.loads(GRANTS_FILE.read_text())
    except json.JSONDecodeError:
        return {
            "valid": False,
            "reason": "Invalid grants file"
        }
    
    if token not in grants:
        return {
            "valid": False,
            "reason": "Token not found"
        }
    
    grant = grants[token]

    # Guard against tampered grant records (checks HMAC-SHA256 signature)
    sig_result = _verify_grant_sig(grant)
    if sig_result is False:
        return {
            "valid": False,
            "reason": "Token signature invalid — grant record may have been tampered with",
        }

    # Check expiration
    expires_at = grant.get("expires_at")
    if expires_at:
        try:
            expiry = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            
            if now > expiry:
                return {
                    "valid": False,
                    "reason": "Token has expired",
                    "expired_at": expires_at
                }
        except Exception:
            pass  # unparseable expiry field — treat token as non-expired
    
    return {
        "valid": True,
        "grant": grant,
        "sig_verified": sig_result is True,
    }


def main():
    parser = argparse.ArgumentParser(description="Validate a permission grant token")
    parser.add_argument("token", help="Grant token to validate")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--env",
        default="",
        help="Target environment (dev|st|sit|qa|sandbox|preprod|prod). Overrides NETWORK_AI_ENV."
    )
    
    args = parser.parse_args()

    # Re-resolve data paths if --env was provided explicitly
    global GRANTS_FILE
    if args.env:
        GRANTS_FILE = _resolve_data_dir(args.env) / "active_grants.json"

    result = validate_token(args.token)
    
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["valid"]:
            grant = result["grant"]
            print("✅ Token is VALID")
            print(f"   Agent: {grant.get('agent_id')}")
            print(f"   Resource: {grant.get('resource_type')}")
            print(f"   Scope: {grant.get('scope', 'N/A')}")
            print(f"   Expires: {grant.get('expires_at')}")
            print(f"   Restrictions: {', '.join(grant.get('restrictions', []))}")
        else:
            print("❌ Token is INVALID")
            print(f"   Reason: {result.get('reason')}")
    
    sys.exit(0 if result["valid"] else 1)


if __name__ == "__main__":
    main()
