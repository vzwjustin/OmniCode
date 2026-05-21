"""Shared test fixtures: in-process app with a fake OpenRouter client."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import pytest

# Ensure the project root is importable when running ``pytest`` from any dir.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Set a deterministic env BEFORE importing the app.
os.environ.setdefault("OPENROUTER_API_KEY", "sk-or-v1-test-key-for-tests-only")
os.environ.setdefault("SERVICE_API_KEYS", "local-test-key-1,local-test-key-2")
os.environ.setdefault("RATE_LIMIT_CAPACITY", "1000")
os.environ.setdefault("RATE_LIMIT_REFILL_PER_MINUTE", "1000")
os.environ.setdefault("LOCAL_TOKEN_BUDGET_PER_KEY", "0")
os.environ.setdefault("CACHE_TTL_SECONDS", "60")
os.environ.setdefault("MAX_ANALYSIS_MODELS", "8")
os.environ.setdefault("MAX_MODEL_CONCURRENCY", "8")
os.environ.setdefault(
    "DEFAULT_ANALYSIS_MODELS",
    "anthropic/claude-sonnet-4.5,openai/gpt-4.1,google/gemini-2.5-pro",
)
os.environ.setdefault("DEFAULT_JUDGE_MODEL", "anthropic/claude-opus-4.1")
os.environ.setdefault("DEFAULT_CRITIC_MODEL", "anthropic/claude-sonnet-4.5")

from fastapi.testclient import TestClient  # noqa: E402

from app.cache import TTLCache  # noqa: E402
from app.client import ChatCompletionResult, OpenRouterClient  # noqa: E402
from app.config import get_settings, reset_settings_cache  # noqa: E402
from app.main import create_app  # noqa: E402
from app.orchestrator import FusionOrchestrator  # noqa: E402
from app.quota import TokenQuota  # noqa: E402
from app.rate_limit import TokenBucketLimiter  # noqa: E402
from app.schemas import UsageInfo  # noqa: E402


class FakeOpenRouterClient(OpenRouterClient):
    """Test double that does not perform HTTP and returns scripted replies.

    ``responses`` maps model id -> either a ChatCompletionResult, a callable
    ``(messages) -> ChatCompletionResult``, or an Exception to raise.
    """

    def __init__(self) -> None:
        self.settings = get_settings()
        self._owns_client = False
        self._client = None  # type: ignore[assignment]
        self.responses: Dict[str, Any] = {}
        self.calls: List[Dict[str, Any]] = []
        self.default_handler: Optional[Callable[[str, List[Dict[str, Any]]], ChatCompletionResult]] = None

    async def close(self) -> None:  # noqa: D401
        return None

    async def chat_completion(  # type: ignore[override]
        self,
        model: str,
        messages: List[Dict[str, Any]],
        temperature: float,
        max_tokens: int,
        timeout_seconds: Optional[float] = None,
    ) -> ChatCompletionResult:
        self.calls.append(
            {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
        )
        await asyncio.sleep(0)  # cooperative yield
        if model in self.responses:
            entry = self.responses[model]
            if isinstance(entry, Exception):
                raise entry
            if callable(entry):
                result = entry(messages)
            else:
                result = entry
            if isinstance(result, Exception):
                raise result
            return result
        if self.default_handler is not None:
            return self.default_handler(model, messages)
        return ChatCompletionResult(
            model=model,
            content=f"[fake] reply from {model}",
            finish_reason="stop",
            usage=UsageInfo(prompt_tokens=10, completion_tokens=20, total_tokens=30),
            latency_ms=5,
        )


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    reset_settings_cache()
    yield
    reset_settings_cache()


@pytest.fixture
def fake_client() -> FakeOpenRouterClient:
    return FakeOpenRouterClient()


@pytest.fixture
def test_app(fake_client: FakeOpenRouterClient):
    """Create the FastAPI app with the fake OpenRouter client wired in.

    We bypass the lifespan and assemble state manually so tests stay synchronous.
    """
    settings = get_settings()
    app = create_app()
    orchestrator = FusionOrchestrator(client=fake_client, settings=settings)
    app.state.client = fake_client
    app.state.orchestrator = orchestrator
    app.state.cache = TTLCache(ttl_seconds=settings.CACHE_TTL_SECONDS)
    app.state.limiter = TokenBucketLimiter(
        capacity=settings.RATE_LIMIT_CAPACITY,
        refill_per_minute=settings.RATE_LIMIT_REFILL_PER_MINUTE,
    )
    app.state.quota = TokenQuota(budget_per_key=settings.LOCAL_TOKEN_BUDGET_PER_KEY)
    return app


@pytest.fixture
def client(test_app):
    # Important: do NOT use ``with TestClient(...)`` — that triggers the
    # lifespan which would build a real OpenRouter client and overwrite our
    # fake. Bare TestClient skips lifespan, which is exactly what we want.
    return TestClient(test_app, raise_server_exceptions=True)


def auth_headers() -> Dict[str, str]:
    return {"Authorization": "Bearer local-test-key-1"}
