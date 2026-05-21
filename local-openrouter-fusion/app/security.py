"""Local bearer / X-API-Key auth using constant-time comparison."""

from __future__ import annotations

import hashlib
import secrets
from typing import Optional

from fastapi import Header, HTTPException, status

from .config import get_settings


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.strip().split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


def _match_any(candidate: str, allowed: list[str]) -> bool:
    cand_bytes = candidate.encode("utf-8")
    matched = False
    # Compare against every allowed key so timing is independent of position.
    for key in allowed:
        key_bytes = key.encode("utf-8")
        if len(key_bytes) == len(cand_bytes) and secrets.compare_digest(
            key_bytes, cand_bytes
        ):
            matched = True
    return matched


def hash_caller_key(key: str) -> str:
    """Stable, non-reversible identifier for rate-limit / quota buckets."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]


async def require_api_key(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> str:
    settings = get_settings()
    allowed = [k for k in settings.SERVICE_API_KEYS if k]
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Service has no SERVICE_API_KEYS configured.",
        )

    presented = _extract_bearer(authorization) or (
        x_api_key.strip() if x_api_key else None
    )
    if not presented:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing local API key.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not _match_any(presented, allowed):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid local API key.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return hash_caller_key(presented)
