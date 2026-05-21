"""Auth, rate limit, and log-redaction tests."""

from __future__ import annotations

import logging

import pytest

from app.logger import redact
from app.rate_limit import TokenBucketLimiter


def test_health_does_not_require_auth(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "operational"
    assert body["native_openrouter_fusion"] is False


def test_fuse_missing_auth_rejected(client):
    r = client.post("/v1/fuse", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 401


def test_fuse_wrong_auth_rejected(client):
    r = client.post(
        "/v1/fuse",
        json={"messages": [{"role": "user", "content": "hi"}]},
        headers={"Authorization": "Bearer nope"},
    )
    assert r.status_code == 401


def test_fuse_xapikey_header_accepted(client):
    r = client.post(
        "/v1/fuse",
        json={"messages": [{"role": "user", "content": "hi"}]},
        headers={"X-API-Key": "local-test-key-2"},
    )
    # Auth passes; orchestrator returns 200 with the fake client default reply.
    assert r.status_code == 200


def test_fuse_extra_field_rejected(client):
    r = client.post(
        "/v1/fuse",
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "secret_field": "x",
        },
        headers={"Authorization": "Bearer local-test-key-1"},
    )
    assert r.status_code == 422


def test_models_list_requires_auth(client):
    assert client.get("/v1/models").status_code == 401
    r = client.get("/v1/models", headers={"Authorization": "Bearer local-test-key-1"})
    assert r.status_code == 200
    body = r.json()
    assert body["object"] == "list"
    ids = [m["id"] for m in body["data"]]
    assert "local-fusion" in ids
    assert "local-fusion-code" in ids


@pytest.mark.asyncio
async def test_rate_limit_returns_429():
    limiter = TokenBucketLimiter(capacity=2, refill_per_minute=0)
    ok1, _ = await limiter.acquire("k1")
    ok2, _ = await limiter.acquire("k1")
    ok3, retry = await limiter.acquire("k1")
    assert ok1 and ok2
    assert not ok3
    assert retry == float("inf")


@pytest.mark.asyncio
async def test_rate_limit_refills():
    limiter = TokenBucketLimiter(capacity=1, refill_per_minute=600)  # 10/sec
    ok1, _ = await limiter.acquire("k1")
    ok2, retry = await limiter.acquire("k1")
    assert ok1
    assert not ok2
    assert 0 < retry < 1


def test_log_redaction_masks_openrouter_key():
    masked = redact("calling with sk-or-v1-AAAAAAAAAAAAAAAAAA right now")
    assert "sk-or-v1" not in masked
    assert "[REDACTED]" in masked


def test_log_redaction_masks_bearer():
    masked = redact("Authorization: Bearer abc.def-ghi_jkl12345")
    assert "abc.def-ghi_jkl12345" not in masked
    assert "[REDACTED]" in masked


def test_log_redaction_passthrough_for_normal_text():
    assert redact("nothing sensitive here") == "nothing sensitive here"


def test_redacting_filter_applied_on_root_logger(caplog):
    # The configure_logging() call on get_logger() installs the filter on the
    # root handler. caplog inserts its own handler, so use the filter directly.
    from app.logger import _RedactingFilter

    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="using sk-or-v1-XXXXXXXXXXXXXXXXXX now",
        args=(),
        exc_info=None,
    )
    _RedactingFilter().filter(record)
    assert "sk-or-v1" not in record.msg
