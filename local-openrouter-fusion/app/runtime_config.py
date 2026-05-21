"""Persisted runtime configuration applied to requests that omit fields.

The frontend UI mutates this; the OpenAI-compatible endpoint reads it as a
fallback before falling further back to ``Settings`` defaults. This is what
makes the proxy behave like a "custom LLM" — coding tools (Claude Code,
Codex CLI, an IDE) call ``/v1/chat/completions`` with model ``local-fusion``
and the configured fusion behavior is applied transparently.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .logger import get_logger
from .schemas import FusionMode

logger = get_logger("local_fusion.runtime_config")


class ActiveConfig(BaseModel):
    """User-customizable fusion defaults applied per OpenAI-compat call."""

    model_config = ConfigDict(extra="forbid")

    analysis_models: Optional[List[str]] = None
    judge_model: Optional[str] = None
    critic_model: Optional[str] = None
    mode: FusionMode = "balanced"
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int = Field(default=4000, ge=1, le=32_000)
    enable_critique: bool = True
    enable_cache: bool = True

    @field_validator("analysis_models")
    @classmethod
    def _strip_models(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        cleaned = [m.strip() for m in v if m and m.strip()]
        return cleaned or None

    @field_validator("judge_model", "critic_model")
    @classmethod
    def _strip_scalar(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        return v or None


class ActiveConfigStore:
    """In-memory store with atomic JSON file persistence."""

    def __init__(self, path: Optional[Path], initial: ActiveConfig) -> None:
        self.path = path
        self._config = initial
        self._lock = asyncio.Lock()

    @classmethod
    def load(cls, path: Optional[Path], fallback: ActiveConfig) -> "ActiveConfigStore":
        if path is None:
            return cls(path=None, initial=fallback)
        try:
            if path.exists():
                raw = path.read_text(encoding="utf-8")
                data = json.loads(raw) if raw.strip() else {}
                cfg = ActiveConfig(**data)
                logger.info("Loaded active config from %s", path)
                return cls(path=path, initial=cfg)
        except (OSError, ValueError) as exc:
            logger.warning(
                "Could not load active config from %s (%s); using fallback.",
                path,
                exc.__class__.__name__,
            )
        return cls(path=path, initial=fallback)

    async def get(self) -> ActiveConfig:
        async with self._lock:
            return self._config.model_copy(deep=True)

    def get_sync(self) -> ActiveConfig:
        return self._config.model_copy(deep=True)

    async def replace(self, new_config: ActiveConfig) -> ActiveConfig:
        async with self._lock:
            self._config = new_config
            self._persist_locked()
            return self._config.model_copy(deep=True)

    async def patch(self, partial: dict) -> ActiveConfig:
        async with self._lock:
            merged = self._config.model_dump()
            merged.update({k: v for k, v in partial.items() if v is not None or k in merged})
            self._config = ActiveConfig(**merged)
            self._persist_locked()
            return self._config.model_copy(deep=True)

    def _persist_locked(self) -> None:
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = self._config.model_dump_json(indent=2)
            # Atomic write: write to temp in the same dir, then rename.
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=str(self.path.parent),
                prefix=".tmp-",
                suffix=".json",
                delete=False,
            ) as tmp:
                tmp.write(payload)
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp_path = Path(tmp.name)
            tmp_path.replace(self.path)
        except OSError as exc:
            logger.warning(
                "Failed to persist active config to %s: %s",
                self.path,
                exc.__class__.__name__,
            )


def default_active_config_from_settings(settings) -> ActiveConfig:  # noqa: ANN001
    return ActiveConfig(
        analysis_models=list(settings.DEFAULT_ANALYSIS_MODELS) or None,
        judge_model=settings.DEFAULT_JUDGE_MODEL or None,
        critic_model=settings.DEFAULT_CRITIC_MODEL or None,
        mode="balanced",
        temperature=0.2,
        max_tokens=4000,
        enable_critique=True,
        enable_cache=True,
    )
