"""In-memory TTL cache for fuse responses."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import Any, Dict, Optional, Tuple

from .schemas import FusionRequest, FusionResponse


def make_cache_key(req: FusionRequest, analysis_models: list[str], judge_model: str,
                   critic_model: Optional[str]) -> str:
    """Build a stable cache key from semantic request fields.

    ``include_candidates`` and ``include_trace`` are deliberately part of
    the key — a trace-requesting caller must not get a non-trace cached
    response.
    """
    payload: Dict[str, Any] = {
        "messages": [m.model_dump() for m in req.messages],
        "analysis_models": list(analysis_models),
        "judge_model": judge_model,
        "critic_model": critic_model,
        "mode": req.mode,
        "temperature": round(float(req.temperature), 6),
        "max_tokens": int(req.max_tokens),
        "enable_critique": bool(req.enable_critique),
        "include_candidates": bool(req.include_candidates),
        "include_trace": bool(req.include_trace),
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class TTLCache:
    """Async-safe TTL cache. Value type is ``FusionResponse``."""

    def __init__(self, ttl_seconds: int, max_entries: int = 512) -> None:
        if ttl_seconds < 0:
            raise ValueError("ttl_seconds must be >= 0")
        if max_entries < 1:
            raise ValueError("max_entries must be >= 1")
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._store: Dict[str, Tuple[float, FusionResponse]] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> Optional[FusionResponse]:
        if self.ttl_seconds <= 0:
            return None
        async with self._lock:
            entry = self._store.get(key)
            if not entry:
                return None
            expires_at, value = entry
            if expires_at < time.monotonic():
                self._store.pop(key, None)
                return None
            return value

    async def set(self, key: str, value: FusionResponse) -> None:
        if self.ttl_seconds <= 0:
            return
        async with self._lock:
            if len(self._store) >= self.max_entries:
                # Evict an arbitrary oldest entry by insertion order.
                try:
                    oldest_key = next(iter(self._store))
                    self._store.pop(oldest_key, None)
                except StopIteration:
                    pass
            self._store[key] = (time.monotonic() + self.ttl_seconds, value)

    def reset(self) -> None:
        self._store.clear()
