"""Orchestrator behavior tests: parallel calls, partial failure, judge fallback, openai-compat."""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, List

import pytest

from app.client import ChatCompletionResult, OpenRouterError
from app.schemas import UsageInfo
from tests.conftest import auth_headers


def _ok(model: str, content: str = "ok", total: int = 30) -> ChatCompletionResult:
    return ChatCompletionResult(
        model=model,
        content=content,
        finish_reason="stop",
        usage=UsageInfo(prompt_tokens=10, completion_tokens=20, total_tokens=total),
        latency_ms=5,
    )


def _request(**overrides) -> Dict[str, Any]:
    base = {
        "messages": [{"role": "user", "content": "explain async io"}],
        "mode": "balanced",
        "include_candidates": True,
        "enable_critique": False,
        "enable_cache": False,
    }
    base.update(overrides)
    return base


def test_fuse_happy_path_returns_single_answer(client, fake_client):
    fake_client.responses["anthropic/claude-sonnet-4.5"] = _ok(
        "anthropic/claude-sonnet-4.5", "draft from sonnet"
    )
    fake_client.responses["openai/gpt-4.1"] = _ok("openai/gpt-4.1", "draft from gpt-4.1")
    fake_client.responses["google/gemini-2.5-pro"] = _ok(
        "google/gemini-2.5-pro", "draft from gemini"
    )
    fake_client.responses["anthropic/claude-opus-4.1"] = _ok(
        "anthropic/claude-opus-4.1", "FINAL FUSED ANSWER"
    )

    r = client.post(
        "/v1/fuse",
        json=_request(include_candidates=False),
        headers=auth_headers(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["answer"] == "FINAL FUSED ANSWER"
    assert "candidates" not in body or body["candidates"] is None
    meta = body["meta"]
    assert meta["mode"] == "balanced"
    assert meta["judge_model"] == "anthropic/claude-opus-4.1"
    assert meta["judge_failed"] is False
    assert meta["usage"]["total_tokens"] >= 30


def test_fuse_one_model_fails_others_succeed(client, fake_client):
    fake_client.responses["anthropic/claude-sonnet-4.5"] = OpenRouterError(429, "rate limited")
    fake_client.responses["openai/gpt-4.1"] = _ok("openai/gpt-4.1", "gpt content")
    fake_client.responses["google/gemini-2.5-pro"] = _ok("google/gemini-2.5-pro", "gem content")
    fake_client.responses["anthropic/claude-opus-4.1"] = _ok(
        "anthropic/claude-opus-4.1", "FUSED with 2 candidates"
    )

    r = client.post("/v1/fuse", json=_request(), headers=auth_headers())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["answer"] == "FUSED with 2 candidates"
    assert body["candidates"] is not None
    by_model = {c["model"]: c for c in body["candidates"]}
    assert by_model["anthropic/claude-sonnet-4.5"]["error"] is not None
    assert by_model["openai/gpt-4.1"]["error"] is None


def test_fuse_all_models_fail_returns_502(client, fake_client):
    err = OpenRouterError(502, "upstream down")
    fake_client.responses["anthropic/claude-sonnet-4.5"] = err
    fake_client.responses["openai/gpt-4.1"] = err
    fake_client.responses["google/gemini-2.5-pro"] = err
    fake_client.responses["anthropic/claude-opus-4.1"] = _ok(
        "anthropic/claude-opus-4.1", "never reached"
    )

    r = client.post("/v1/fuse", json=_request(), headers=auth_headers())
    assert r.status_code == 502
    body = r.json()
    assert "all_analysis_models_failed" in str(body)


def test_fuse_judge_fallback_uses_best_candidate(client, fake_client):
    fake_client.responses["anthropic/claude-sonnet-4.5"] = _ok(
        "anthropic/claude-sonnet-4.5", "shorter"
    )
    fake_client.responses["openai/gpt-4.1"] = _ok(
        "openai/gpt-4.1", "this is the longest candidate response and should win the fallback selection"
    )
    fake_client.responses["google/gemini-2.5-pro"] = _ok(
        "google/gemini-2.5-pro", "medium length response"
    )
    fake_client.responses["anthropic/claude-opus-4.1"] = OpenRouterError(502, "judge down")

    r = client.post("/v1/fuse", json=_request(), headers=auth_headers())
    assert r.status_code == 200, r.text
    body = r.json()
    assert "longest candidate" in body["answer"]
    meta = body["meta"]
    assert meta["judge_failed"] is True
    assert meta["fallback_reason"] == "judge_fallback_to:openai/gpt-4.1"


def test_fuse_cache_hit_does_not_call_models_again(client, fake_client):
    for m in [
        "anthropic/claude-sonnet-4.5",
        "openai/gpt-4.1",
        "google/gemini-2.5-pro",
        "anthropic/claude-opus-4.1",
    ]:
        fake_client.responses[m] = _ok(m, f"reply-from-{m}")

    payload = _request(enable_cache=True, include_candidates=False)
    r1 = client.post("/v1/fuse", json=payload, headers=auth_headers())
    assert r1.status_code == 200
    calls_first = len(fake_client.calls)
    assert calls_first > 0
    assert r1.json()["meta"]["cached"] is False

    r2 = client.post("/v1/fuse", json=payload, headers=auth_headers())
    assert r2.status_code == 200
    assert len(fake_client.calls) == calls_first, "Cache hit should not call the client"
    assert r2.json()["meta"]["cached"] is True
    assert r2.json()["answer"] == r1.json()["answer"]


def test_fuse_allowed_models_whitelist(monkeypatch, fake_client):
    """When ALLOWED_MODELS is set, requested models outside the whitelist are rejected."""
    monkeypatch.setenv("ALLOWED_MODELS", "anthropic/claude-opus-4.1,anthropic/claude-sonnet-4.5")
    from app.config import reset_settings_cache

    reset_settings_cache()
    # Build a fresh app instance picking up the new env.
    from app.config import get_settings
    from app.main import create_app
    from app.orchestrator import FusionOrchestrator
    from app.cache import TTLCache
    from app.rate_limit import TokenBucketLimiter
    from app.quota import TokenQuota
    from fastapi.testclient import TestClient

    settings = get_settings()
    app = create_app()
    app.state.client = fake_client
    app.state.orchestrator = FusionOrchestrator(client=fake_client, settings=settings)
    app.state.cache = TTLCache(ttl_seconds=settings.CACHE_TTL_SECONDS)
    app.state.limiter = TokenBucketLimiter(
        capacity=settings.RATE_LIMIT_CAPACITY,
        refill_per_minute=settings.RATE_LIMIT_REFILL_PER_MINUTE,
    )
    app.state.quota = TokenQuota(budget_per_key=settings.LOCAL_TOKEN_BUDGET_PER_KEY)
    c = TestClient(app)

    r = c.post(
        "/v1/fuse",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "analysis_models": ["openai/gpt-4.1"],  # not in ALLOWED_MODELS
            "judge_model": "anthropic/claude-opus-4.1",
            "mode": "balanced",
            "enable_critique": False,
            "enable_cache": False,
        },
        headers=auth_headers(),
    )
    assert r.status_code == 400
    body = r.json()
    assert "ALLOWED_MODELS" in str(body)


def test_openai_compat_chat_completions_basic(client, fake_client):
    fake_client.responses["anthropic/claude-opus-4.1"] = _ok(
        "anthropic/claude-opus-4.1", "openai-compat fused answer"
    )
    r = client.post(
        "/v1/chat/completions",
        json={
            "model": "local-fusion",
            "messages": [{"role": "user", "content": "hi"}],
            "enable_critique": False,
            "enable_cache": False,
        },
        headers=auth_headers(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["content"] == "openai-compat fused answer"
    assert body["choices"][0]["finish_reason"] == "stop"
    assert body["x_local_fusion"]["mode"] == "balanced"


def test_openai_compat_inline_model_config(client, fake_client):
    fake_client.responses["openai/gpt-4.1"] = _ok("openai/gpt-4.1", "g")
    fake_client.responses["anthropic/claude-sonnet-4.5"] = _ok(
        "anthropic/claude-sonnet-4.5", "s"
    )
    fake_client.responses["anthropic/claude-opus-4.1"] = _ok(
        "anthropic/claude-opus-4.1", "inline-fused"
    )
    r = client.post(
        "/v1/chat/completions",
        json={
            "model": "local-fusion-code:openai/gpt-4.1+anthropic/claude-sonnet-4.5@anthropic/claude-opus-4.1",
            "messages": [{"role": "user", "content": "audit"}],
            "enable_critique": False,
            "enable_cache": False,
        },
        headers=auth_headers(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["choices"][0]["message"]["content"] == "inline-fused"
    assert body["x_local_fusion"]["mode"] == "code"
    assert body["x_local_fusion"]["judge_model"] == "anthropic/claude-opus-4.1"
    assert set(body["x_local_fusion"]["analysis_models"]) == {
        "openai/gpt-4.1",
        "anthropic/claude-sonnet-4.5",
    }


def test_openai_compat_unknown_model_rejected(client):
    r = client.post(
        "/v1/chat/completions",
        json={
            "model": "definitely-not-fusion",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers=auth_headers(),
    )
    assert r.status_code == 400


def test_openai_compat_stream_emits_sse(client, fake_client):
    fake_client.responses["anthropic/claude-opus-4.1"] = _ok(
        "anthropic/claude-opus-4.1", "streamed answer"
    )
    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "model": "local-fusion",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
            "enable_critique": False,
            "enable_cache": False,
        },
        headers=auth_headers(),
    ) as r:
        assert r.status_code == 200
        body = "".join(chunk for chunk in r.iter_text())
    assert "data: " in body
    assert "streamed answer" in body
    assert "[DONE]" in body
