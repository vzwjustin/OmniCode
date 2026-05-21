"""Local per-key token budget tracker."""

from __future__ import annotations

import asyncio
from typing import Dict


class QuotaExceeded(Exception):
    def __init__(self, used: int, budget: int) -> None:
        super().__init__(f"Local token budget exceeded: used={used} budget={budget}")
        self.used = used
        self.budget = budget


class TokenQuota:
    """Tracks total OpenRouter tokens consumed per local caller key.

    Budget of 0 disables enforcement.
    """

    def __init__(self, budget_per_key: int) -> None:
        if budget_per_key < 0:
            raise ValueError("budget_per_key must be >= 0")
        self.budget_per_key = budget_per_key
        self._used: Dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def check(self, key: str) -> None:
        if self.budget_per_key <= 0:
            return
        async with self._lock:
            used = self._used.get(key, 0)
            if used >= self.budget_per_key:
                raise QuotaExceeded(used, self.budget_per_key)

    async def record(self, key: str, tokens: int) -> None:
        if self.budget_per_key <= 0 or tokens <= 0:
            return
        async with self._lock:
            self._used[key] = self._used.get(key, 0) + int(tokens)

    async def used(self, key: str) -> int:
        async with self._lock:
            return self._used.get(key, 0)

    def reset(self) -> None:
        self._used.clear()
