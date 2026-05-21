"""Tests for the UI-editable runtime config and the /v1/admin/config API."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.client import ChatCompletionResult
from app.runtime_config import ActiveConfig, ActiveConfigStore
from app.schemas import UsageInfo
from tests.conftest import auth_headers


def _ok(model: str, content: str = "ok") -> ChatCompletionResult:
    return ChatCompletionResult(
        model=model,
        content=content,
        finish_reason="stop",
        usage=UsageInfo(prompt_tokens=5, completion_tokens=5, total_tokens=10),
        latency_ms=1,
    )


def test_ui_index_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers.get("content-type", "")
    assert "Local OpenRouter Fusion" in r.text
    assert "/v1/chat/completions" in r.text


def test_ui_alias_served(client):
    r = client.get("/ui")
    assert r.status_code == 200
    assert "<html" in r.text.lower()


def test_admin_config_requires_auth(client):
    assert client.get("/v1/admin/config").status_code == 401
    assert client.put("/v1/admin/config", json={"mode": "deep"}).status_code == 401


def test_admin_config_get_returns_defaults(client):
    r = client.get("/v1/admin/config", headers=auth_headers())
    assert r.status_code == 200
    body = r.json()
    active = body["active"]
    assert active["mode"] in {"fast", "balanced", "deep", "code"}
    assert "analysis_models" in active
    assert "judge_model" in active


def test_admin_config_put_updates_active_config(client):
    r = client.put(
        "/v1/admin/config",
        json={
            "analysis_models": ["local:claude-code", "local:codex"],
            "judge_model": "anthropic/claude-opus-4.1",
            "critic_model": None,
            "mode": "code",
            "temperature": 0.0,
            "max_tokens": 1500,
            "enable_critique": False,
        },
        headers=auth_headers(),
    )
    assert r.status_code == 200, r.text
    active = r.json()["active"]
    assert active["mode"] == "code"
    assert active["analysis_models"] == ["local:claude-code", "local:codex"]
    assert active["judge_model"] == "anthropic/claude-opus-4.1"
    assert active["temperature"] == 0.0
    assert active["max_tokens"] == 1500
    assert active["enable_critique"] is False

    # GET reflects the change.
    r2 = client.get("/v1/admin/config", headers=auth_headers())
    assert r2.json()["active"]["mode"] == "code"


def test_admin_config_rejects_extra_fields(client):
    r = client.put(
        "/v1/admin/config",
        json={"definitely_not_a_field": "x"},
        headers=auth_headers(),
    )
    assert r.status_code == 422


def test_active_config_influences_openai_compat_endpoint(client, fake_client):
    """A request with only ``model`` set should inherit defaults from
    the ActiveConfig — that's the whole proxy-as-custom-LLM use case."""
    # Configure proxy defaults via the admin endpoint.
    cfg_resp = client.put(
        "/v1/admin/config",
        json={
            "analysis_models": ["openai/gpt-4.1"],
            "judge_model": "anthropic/claude-opus-4.1",
            "mode": "fast",
            "enable_critique": False,
            "enable_cache": False,
        },
        headers=auth_headers(),
    )
    assert cfg_resp.status_code == 200

    fake_client.responses["openai/gpt-4.1"] = _ok("openai/gpt-4.1", "single-analysis")
    fake_client.responses["anthropic/claude-opus-4.1"] = _ok(
        "anthropic/claude-opus-4.1", "configured-fused-answer"
    )

    # Coding tool sends a minimal request — no fusion fields, no models.
    r = client.post(
        "/v1/chat/completions",
        json={
            "model": "local-fusion",
            "messages": [{"role": "user", "content": "do the thing"}],
        },
        headers=auth_headers(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["choices"][0]["message"]["content"] == "configured-fused-answer"
    xlf = body["x_local_fusion"]
    assert xlf["mode"] == "fast"
    assert xlf["analysis_models"] == ["openai/gpt-4.1"]
    assert xlf["judge_model"] == "anthropic/claude-opus-4.1"

    # The critic should NOT have been called (enable_critique=False).
    assert not any(
        c["model"] == "anthropic/claude-sonnet-4.5" for c in fake_client.calls
    ), "Critic was disabled via active config but still got called"


def test_active_config_request_overrides_take_priority(client, fake_client):
    """If the OpenAI-compat request explicitly sets a field, that wins over
    the active config."""
    client.put(
        "/v1/admin/config",
        json={
            "analysis_models": ["openai/gpt-4.1"],
            "judge_model": "anthropic/claude-opus-4.1",
            "mode": "balanced",
            "enable_critique": False,
        },
        headers=auth_headers(),
    )
    fake_client.responses["anthropic/claude-sonnet-4.5"] = _ok(
        "anthropic/claude-sonnet-4.5", "explicit-analysis"
    )
    fake_client.responses["anthropic/claude-opus-4.1"] = _ok(
        "anthropic/claude-opus-4.1", "explicit-judge-answer"
    )

    r = client.post(
        "/v1/chat/completions",
        json={
            "model": "local-fusion",
            "messages": [{"role": "user", "content": "x"}],
            "analysis_models": ["anthropic/claude-sonnet-4.5"],
            "enable_cache": False,
        },
        headers=auth_headers(),
    )
    assert r.status_code == 200
    body = r.json()
    # Explicit analysis_models wins.
    assert body["x_local_fusion"]["analysis_models"] == ["anthropic/claude-sonnet-4.5"]
    # Judge inherited from active config.
    assert body["x_local_fusion"]["judge_model"] == "anthropic/claude-opus-4.1"


@pytest.mark.asyncio
async def test_active_config_store_persists_to_disk(tmp_path: Path):
    path = tmp_path / "fusion_config.json"
    store = ActiveConfigStore(
        path=path,
        initial=ActiveConfig(mode="balanced"),
    )
    await store.replace(
        ActiveConfig(
            analysis_models=["local:claude-code", "local:codex"],
            judge_model="anthropic/claude-opus-4.1",
            mode="code",
            temperature=0.1,
            max_tokens=2500,
            enable_critique=False,
            enable_cache=True,
        )
    )
    assert path.exists()
    on_disk = json.loads(path.read_text("utf-8"))
    assert on_disk["mode"] == "code"
    assert on_disk["analysis_models"] == ["local:claude-code", "local:codex"]
    assert on_disk["judge_model"] == "anthropic/claude-opus-4.1"
    assert on_disk["temperature"] == 0.1


@pytest.mark.asyncio
async def test_active_config_store_load_from_disk(tmp_path: Path):
    path = tmp_path / "fusion_config.json"
    path.write_text(
        json.dumps(
            {
                "analysis_models": ["openai/gpt-4.1"],
                "judge_model": "anthropic/claude-opus-4.1",
                "mode": "deep",
                "temperature": 0.5,
                "max_tokens": 1200,
                "enable_critique": True,
                "enable_cache": False,
            }
        ),
        encoding="utf-8",
    )
    store = ActiveConfigStore.load(path=path, fallback=ActiveConfig())
    cfg = await store.get()
    assert cfg.mode == "deep"
    assert cfg.analysis_models == ["openai/gpt-4.1"]
    assert cfg.judge_model == "anthropic/claude-opus-4.1"
    assert cfg.temperature == 0.5
    assert cfg.max_tokens == 1200
    assert cfg.enable_critique is True
    assert cfg.enable_cache is False


@pytest.mark.asyncio
async def test_active_config_store_load_handles_corrupt_file(tmp_path: Path):
    path = tmp_path / "fusion_config.json"
    path.write_text("{ not valid json", encoding="utf-8")
    fallback = ActiveConfig(mode="balanced", judge_model="anthropic/claude-opus-4.1")
    store = ActiveConfigStore.load(path=path, fallback=fallback)
    cfg = await store.get()
    assert cfg.judge_model == "anthropic/claude-opus-4.1"
    assert cfg.mode == "balanced"


def test_active_config_strips_blank_models():
    cfg = ActiveConfig(
        analysis_models=["  ", "anthropic/claude-opus-4.1", ""],
        judge_model="  anthropic/claude-opus-4.1  ",
        critic_model="   ",
    )
    assert cfg.analysis_models == ["anthropic/claude-opus-4.1"]
    assert cfg.judge_model == "anthropic/claude-opus-4.1"
    assert cfg.critic_model is None
