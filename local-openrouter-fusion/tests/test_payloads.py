"""Schema-level tests: payload shape, validation, cache key, openai-compat parsing."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.cache import make_cache_key
from app.schemas import FusionRequest, Message


def _base_request(**overrides) -> dict:
    payload = {
        "messages": [{"role": "user", "content": "hi"}],
        "mode": "balanced",
    }
    payload.update(overrides)
    return payload


def test_fusion_request_minimum_valid():
    req = FusionRequest(**_base_request())
    assert req.mode == "balanced"
    assert req.temperature == 0.2
    assert req.max_tokens == 4000
    assert req.enable_critique is True
    assert req.enable_cache is True
    assert req.include_candidates is False
    assert req.include_trace is False


def test_fusion_request_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        FusionRequest(**_base_request(unknown_field="x"))


def test_fusion_request_rejects_empty_messages():
    with pytest.raises(ValidationError):
        FusionRequest(messages=[])


def test_fusion_request_rejects_oversized_content():
    huge = "a" * 70_000
    with pytest.raises(ValidationError):
        FusionRequest(messages=[{"role": "user", "content": huge}])


def test_fusion_request_strips_blank_models():
    req = FusionRequest(
        **_base_request(
            analysis_models=["  ", "anthropic/claude-sonnet-4.5", " "],
            judge_model="  anthropic/claude-opus-4.1  ",
            critic_model="  ",
        )
    )
    assert req.analysis_models == ["anthropic/claude-sonnet-4.5"]
    assert req.judge_model == "anthropic/claude-opus-4.1"
    assert req.critic_model is None


def test_message_rejects_bad_role():
    with pytest.raises(ValidationError):
        Message(role="weirdrole", content="x")


def test_cache_key_stable_for_same_request():
    a = FusionRequest(**_base_request())
    b = FusionRequest(**_base_request())
    k1 = make_cache_key(a, ["m1", "m2"], "judge", "critic")
    k2 = make_cache_key(b, ["m1", "m2"], "judge", "critic")
    assert k1 == k2


def test_cache_key_changes_with_mode():
    a = FusionRequest(**_base_request(mode="balanced"))
    b = FusionRequest(**_base_request(mode="deep"))
    k1 = make_cache_key(a, ["m1"], "j", None)
    k2 = make_cache_key(b, ["m1"], "j", None)
    assert k1 != k2


def test_cache_key_changes_with_models():
    a = FusionRequest(**_base_request())
    k1 = make_cache_key(a, ["m1", "m2"], "j", None)
    k2 = make_cache_key(a, ["m2", "m1"], "j", None)
    assert k1 != k2  # order matters since the analysis order is meaningful


def test_cache_key_changes_with_trace_flag():
    a = FusionRequest(**_base_request(include_trace=False))
    b = FusionRequest(**_base_request(include_trace=True))
    k1 = make_cache_key(a, ["m1"], "j", None)
    k2 = make_cache_key(b, ["m1"], "j", None)
    assert k1 != k2


def test_invalid_temperature_rejected():
    with pytest.raises(ValidationError):
        FusionRequest(**_base_request(temperature=2.5))


def test_invalid_mode_rejected():
    with pytest.raises(ValidationError):
        FusionRequest(**_base_request(mode="zoom"))
