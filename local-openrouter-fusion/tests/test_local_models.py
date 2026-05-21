"""Local CLI model adapter tests.

We avoid hitting real ``claude`` / ``codex`` / ``gemini`` binaries by either
unit-testing the registry directly or by pointing the configured command at
a Python one-liner that echoes a deterministic reply on stdout.
"""

from __future__ import annotations

import os
import shutil
import sys

import pytest

from app.client import ChatCompletionResult, OpenRouterError
from app.config import get_settings, reset_settings_cache
from app.dispatcher import CompletionDispatcher
from app.local_models import (
    LocalModelRegistry,
    LocalModelRunner,
    messages_to_prompt,
)


def test_local_registry_disabled_by_default():
    reset_settings_cache()
    # Clear any env-set CMDs from this test's perspective.
    os.environ.pop("LOCAL_CLAUDE_CODE_CMD", None)
    os.environ.pop("LOCAL_CODEX_CMD", None)
    os.environ.pop("LOCAL_GEMINI_CMD", None)
    reset_settings_cache()
    settings = get_settings()
    reg = LocalModelRegistry(settings)
    assert reg.resolve("local:claude-code") is None
    assert reg.resolve("local:codex") is None
    assert reg.resolve("local:gemini") is None
    assert reg.configured_ids() == []


def test_local_registry_enables_via_env(monkeypatch):
    monkeypatch.setenv("LOCAL_CLAUDE_CODE_CMD", "claude")
    monkeypatch.setenv("LOCAL_CLAUDE_CODE_ARGS", "-p,--output-format,text")
    monkeypatch.setenv("LOCAL_CODEX_CMD", "codex")
    monkeypatch.setenv("LOCAL_GEMINI_CMD", "gemini")
    reset_settings_cache()
    settings = get_settings()
    reg = LocalModelRegistry(settings)
    cfg = reg.resolve("local:claude-code")
    assert cfg is not None
    assert cfg.cmd == "claude"
    assert cfg.args == ("-p", "--output-format", "text")
    assert reg.resolve("local:codex") is not None
    assert reg.resolve("local:gemini") is not None
    assert set(reg.configured_ids()) >= {"local:claude-code", "local:codex", "local:gemini"}


def test_is_local_prefix():
    reset_settings_cache()
    settings = get_settings()
    reg = LocalModelRegistry(settings)
    assert reg.is_local("local:claude-code") is True
    assert reg.is_local("anthropic/claude-opus-4.1") is False
    assert reg.is_local("") is False


def test_messages_to_prompt_flattens_roles():
    out = messages_to_prompt(
        [
            {"role": "system", "content": "be terse"},
            {"role": "user", "content": "explain"},
            {"role": "assistant", "content": "prior reply"},
        ]
    )
    assert "<<SYSTEM>>\nbe terse" in out
    assert "<<USER>>\nexplain" in out
    assert "<<ASSISTANT>>\nprior reply" in out


def test_messages_to_prompt_handles_list_content():
    out = messages_to_prompt(
        [{"role": "user", "content": [{"type": "text", "text": "hello "}, {"text": "world"}]}]
    )
    assert "hello world" in out


@pytest.mark.asyncio
async def test_local_runner_executes_real_subprocess(monkeypatch):
    """End-to-end test: a python one-liner stands in for the CLI binary."""
    python = sys.executable
    assert python and shutil.which(python)
    # Echo whatever stdin contains, prefixed with a marker.
    script = (
        "import sys; data = sys.stdin.read(); "
        "sys.stdout.write('LOCAL_OUT:' + data.strip().splitlines()[-1])"
    )

    monkeypatch.setenv("LOCAL_CLAUDE_CODE_CMD", python)
    monkeypatch.setenv("LOCAL_CLAUDE_CODE_ARGS", f"-c,{script}")
    monkeypatch.setenv("LOCAL_MODEL_TIMEOUT_SECONDS", "30")
    reset_settings_cache()
    settings = get_settings()

    reg = LocalModelRegistry(settings)
    runner = LocalModelRunner(reg, settings)
    result = await runner.chat_completion(
        model="local:claude-code",
        messages=[{"role": "user", "content": "hello-from-test"}],
        temperature=0.2,
        max_tokens=10,
    )
    assert isinstance(result, ChatCompletionResult)
    assert result.content.startswith("LOCAL_OUT:")
    assert "hello-from-test" in result.content
    assert result.finish_reason == "stop"
    assert result.latency_ms >= 0


@pytest.mark.asyncio
async def test_local_runner_unconfigured_model_raises(monkeypatch):
    monkeypatch.delenv("LOCAL_CLAUDE_CODE_CMD", raising=False)
    monkeypatch.delenv("LOCAL_CODEX_CMD", raising=False)
    monkeypatch.delenv("LOCAL_GEMINI_CMD", raising=False)
    reset_settings_cache()
    settings = get_settings()
    reg = LocalModelRegistry(settings)
    runner = LocalModelRunner(reg, settings)
    with pytest.raises(OpenRouterError) as exc:
        await runner.chat_completion(
            model="local:claude-code",
            messages=[{"role": "user", "content": "x"}],
            temperature=0.2,
            max_tokens=10,
        )
    assert exc.value.status_code in (400, 502)


@pytest.mark.asyncio
async def test_local_runner_nonzero_exit_reports_error(monkeypatch):
    python = sys.executable
    # Exit non-zero and write to stderr.
    script = "import sys; sys.stderr.write('boom from local cli'); sys.exit(3)"
    monkeypatch.setenv("LOCAL_CODEX_CMD", python)
    monkeypatch.setenv("LOCAL_CODEX_ARGS", f"-c,{script}")
    monkeypatch.setenv("LOCAL_MODEL_TIMEOUT_SECONDS", "30")
    reset_settings_cache()
    settings = get_settings()
    reg = LocalModelRegistry(settings)
    runner = LocalModelRunner(reg, settings)
    with pytest.raises(OpenRouterError) as exc:
        await runner.chat_completion(
            model="local:codex",
            messages=[{"role": "user", "content": "x"}],
            temperature=0.2,
            max_tokens=10,
        )
    assert exc.value.status_code == 502
    assert "exited with code 3" in exc.value.message


@pytest.mark.asyncio
async def test_dispatcher_routes_local_vs_remote(monkeypatch, fake_client):
    """Dispatcher should send local: ids to the local runner and pass through
    remote ids to the OpenRouter client."""
    python = sys.executable
    script = "import sys; sys.stdout.write('claude-code-said-hi')"
    monkeypatch.setenv("LOCAL_CLAUDE_CODE_CMD", python)
    monkeypatch.setenv("LOCAL_CLAUDE_CODE_ARGS", f"-c,{script}")
    monkeypatch.setenv("LOCAL_MODEL_TIMEOUT_SECONDS", "30")
    reset_settings_cache()
    settings = get_settings()

    dispatcher = CompletionDispatcher(
        openrouter=fake_client,
        settings=settings,
        local_registry=LocalModelRegistry(settings),
    )
    fake_client.responses["anthropic/claude-opus-4.1"] = ChatCompletionResult(
        model="anthropic/claude-opus-4.1",
        content="from-openrouter",
        finish_reason="stop",
        usage=None,
        latency_ms=1,
    )

    local_res = await dispatcher.chat_completion(
        model="local:claude-code",
        messages=[{"role": "user", "content": "ping"}],
        temperature=0.2,
        max_tokens=10,
    )
    assert local_res.content == "claude-code-said-hi"
    # OpenRouter client should NOT have been called for the local model.
    assert not any(c["model"] == "local:claude-code" for c in fake_client.calls)

    remote_res = await dispatcher.chat_completion(
        model="anthropic/claude-opus-4.1",
        messages=[{"role": "user", "content": "ping"}],
        temperature=0.2,
        max_tokens=10,
    )
    assert remote_res.content == "from-openrouter"
    assert any(c["model"] == "anthropic/claude-opus-4.1" for c in fake_client.calls)


@pytest.mark.asyncio
async def test_fully_local_fusion_no_openrouter_calls(monkeypatch, fake_client):
    """Run with local analysis + local judge, no OpenRouter calls at all.

    Reproduces the use case: Claude Code + Codex + Gemini locally, with a
    local model also acting as the judge.
    """
    from app.orchestrator import FusionOrchestrator
    from app.schemas import FusionRequest

    python = sys.executable
    monkeypatch.setenv("LOCAL_CLAUDE_CODE_CMD", python)
    monkeypatch.setenv(
        "LOCAL_CLAUDE_CODE_ARGS", "-c,import sys; sys.stdout.write('claude-draft')"
    )
    monkeypatch.setenv("LOCAL_CODEX_CMD", python)
    monkeypatch.setenv(
        "LOCAL_CODEX_ARGS", "-c,import sys; sys.stdout.write('codex-draft')"
    )
    monkeypatch.setenv("LOCAL_GEMINI_CMD", python)
    monkeypatch.setenv(
        "LOCAL_GEMINI_ARGS",
        "-c,import sys; sys.stdout.write('LOCAL_FUSION:' + sys.stdin.read()[:32])",
    )
    monkeypatch.setenv("LOCAL_MODEL_TIMEOUT_SECONDS", "30")
    reset_settings_cache()
    settings = get_settings()

    dispatcher = CompletionDispatcher(
        openrouter=fake_client,
        settings=settings,
        local_registry=LocalModelRegistry(settings),
    )
    orchestrator = FusionOrchestrator(client=dispatcher, settings=settings)

    request = FusionRequest(
        messages=[{"role": "user", "content": "fully local fusion"}],
        analysis_models=["local:claude-code", "local:codex"],
        judge_model="local:gemini",
        mode="balanced",
        enable_critique=False,
        enable_cache=False,
        include_candidates=True,
    )
    response = await orchestrator.fuse(request, client_hash="test-hash")

    # The remote (fake) OpenRouter client should never have been called.
    assert fake_client.calls == [], (
        "Fully-local fusion must not hit OpenRouter at all"
    )
    assert response.answer.startswith("LOCAL_FUSION:")
    assert response.candidates is not None
    models_seen = {c.model for c in response.candidates}
    assert models_seen == {"local:claude-code", "local:codex"}
    assert response.meta.judge_failed is False
    assert response.meta.judge_model == "local:gemini"


@pytest.mark.asyncio
async def test_dispatcher_fusion_mixes_local_and_remote(monkeypatch, fake_client):
    """Full fusion run: local Claude Code + local Codex + remote judge."""
    from app.orchestrator import FusionOrchestrator
    from app.schemas import FusionRequest

    python = sys.executable
    claude_script = "import sys; sys.stdout.write('claude-local-draft')"
    codex_script = "import sys; sys.stdout.write('codex-local-draft')"
    monkeypatch.setenv("LOCAL_CLAUDE_CODE_CMD", python)
    monkeypatch.setenv("LOCAL_CLAUDE_CODE_ARGS", f"-c,{claude_script}")
    monkeypatch.setenv("LOCAL_CODEX_CMD", python)
    monkeypatch.setenv("LOCAL_CODEX_ARGS", f"-c,{codex_script}")
    monkeypatch.setenv("LOCAL_MODEL_TIMEOUT_SECONDS", "30")
    reset_settings_cache()
    settings = get_settings()

    dispatcher = CompletionDispatcher(
        openrouter=fake_client,
        settings=settings,
        local_registry=LocalModelRegistry(settings),
    )
    fake_client.responses["anthropic/claude-opus-4.1"] = ChatCompletionResult(
        model="anthropic/claude-opus-4.1",
        content="FUSED_FROM_LOCAL_CANDIDATES",
        finish_reason="stop",
        usage=None,
        latency_ms=2,
    )

    orchestrator = FusionOrchestrator(client=dispatcher, settings=settings)
    request = FusionRequest(
        messages=[{"role": "user", "content": "what's 2+2?"}],
        analysis_models=["local:claude-code", "local:codex"],
        judge_model="anthropic/claude-opus-4.1",
        mode="balanced",
        enable_critique=False,
        enable_cache=False,
        include_candidates=True,
    )
    response = await orchestrator.fuse(request, client_hash="test-hash")
    assert response.answer == "FUSED_FROM_LOCAL_CANDIDATES"
    assert response.candidates is not None
    by_model = {c.model: c for c in response.candidates}
    assert by_model["local:claude-code"].content == "claude-local-draft"
    assert by_model["local:codex"].content == "codex-local-draft"
    assert by_model["local:claude-code"].error is None
    assert by_model["local:codex"].error is None
    assert response.meta.judge_failed is False
