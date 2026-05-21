"""In-memory token-bucket rate limiter keyed by hashed caller key."""

from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass
from typing import Dict


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


class TokenBucketLimiter:
    """Async-safe token-bucket limiter.

    capacity: max tokens (also bucket size)
    refill_per_minute: tokens added per minute (steady rate)
    """

    def __init__(self, capacity: int, refill_per_minute: float) -> None:
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        if refill_per_minute < 0:
            raise ValueError("refill_per_minute must be >= 0")
        self.capacity = float(capacity)
        self.refill_per_second = float(refill_per_minute) / 60.0
        self._buckets: Dict[str, _Bucket] = {}
        self._lock = asyncio.Lock()

    def _refill(self, bucket: _Bucket, now: float) -> None:
        elapsed = max(0.0, now - bucket.last_refill)
        bucket.tokens = min(
            self.capacity, bucket.tokens + elapsed * self.refill_per_second
        )
        bucket.last_refill = now

    async def acquire(self, key: str, cost: float = 1.0) -> tuple[bool, float]:
        """Try to consume ``cost`` tokens.

        Returns (allowed, retry_after_seconds). retry_after is 0 when allowed.
        """
        if cost <= 0:
            return True, 0.0
        async with self._lock:
            now = time.monotonic()
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _Bucket(tokens=self.capacity, last_refill=now)
                self._buckets[key] = bucket
            self._refill(bucket, now)
            if bucket.tokens >= cost:
                bucket.tokens -= cost
                return True, 0.0
            if self.refill_per_second <= 0:
                return False, float("inf")
            deficit = cost - bucket.tokens
            retry_after = deficit / self.refill_per_second
            return False, math.ceil(retry_after * 1000) / 1000.0

    def reset(self) -> None:
        self._buckets.clear()
