"""HTTP routes: native /v1/fuse + OpenAI-compatible /v1/chat/completions."""

from __future__ import annotations

import json
import re
import time
import uuid
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from pathlib import Path

from fastapi.responses import FileResponse

from .cache import TTLCache, make_cache_key
from .logger import get_logger
from .orchestrator import FusionOrchestrator
from .quota import QuotaExceeded, TokenQuota
from .rate_limit import TokenBucketLimiter
from .runtime_config import ActiveConfig, ActiveConfigStore
from .schemas import (
    ErrorResponse,
    FusionMeta,
    FusionMode,
    FusionRequest,
    FusionResponse,
    HealthResponse,
    Message,
)
from .security import require_api_key

logger = get_logger("local_fusion.routes")

router = APIRouter()

# --- custom model names (OpenAI-compat) ---
# Base name plus per-mode variants. Claude Code (and any OpenAI-compatible
# client) can simply set ``model`` to one of these to drive fusion.
#
# ``None`` means "no opinion — defer to ActiveConfig". This is what makes
# ``local-fusion`` behave as a true custom-LLM alias: whatever the UI has
# configured is what runs. The explicit ``-fast``/``-balanced``/``-deep``/
# ``-code`` variants do override the active config when used.
FUSION_MODEL_BASE = "local-fusion"
FUSION_MODEL_ALIASES: Dict[str, Optional[FusionMode]] = {
    "local-fusion": None,
    "local-fusion-fast": "fast",
    "local-fusion-balanced": "balanced",
    "local-fusion-deep": "deep",
    "local-fusion-code": "code",
}

# Pattern for the inline-config suffix:
#   local-fusion-code:anthropic/claude-sonnet-4.5+openai/gpt-4.1@anthropic/claude-opus-4.1
_FUSION_INLINE_RE = re.compile(
    r"^(?P<base>local-fusion(?:-(?:fast|balanced|deep|code))?)"
    r"(?::(?P<analysis>[^@]+))?"
    r"(?:@(?P<judge>.+))?$"
)


# ---------- OpenAI-compatible schemas ----------

class _OpenAIMessage(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: Literal["system", "user", "assistant", "tool"]
    content: Any
    name: Optional[str] = None


class _OpenAIChatRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str
    messages: List[_OpenAIMessage] = Field(min_length=1)
    temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(default=None, ge=1, le=32_000)
    stream: Optional[bool] = False
    # Custom extras — let callers control fusion behavior even via OpenAI clients.
    include_candidates: Optional[bool] = None
    include_trace: Optional[bool] = None
    enable_critique: Optional[bool] = None
    enable_cache: Optional[bool] = None
    analysis_models: Optional[List[str]] = None
    judge_model: Optional[str] = None
    critic_model: Optional[str] = None
    fusion_mode: Optional[FusionMode] = None


# ---------- dependencies / wiring ----------

def get_orchestrator(request: Request) -> FusionOrchestrator:
    orchestrator = getattr(request.app.state, "orchestrator", None)
    if orchestrator is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Orchestrator is not initialized.",
        )
    return orchestrator


def get_cache(request: Request) -> TTLCache:
    return request.app.state.cache


def get_limiter(request: Request) -> TokenBucketLimiter:
    return request.app.state.limiter


def get_quota(request: Request) -> TokenQuota:
    return request.app.state.quota


def get_active_config_store(request: Request) -> ActiveConfigStore:
    return request.app.state.active_config


async def _enforce_rate_limit(limiter: TokenBucketLimiter, client_hash: str) -> None:
    allowed, retry_after = await limiter.acquire(client_hash, cost=1.0)
    if not allowed:
        headers = {"Retry-After": str(max(1, int(retry_after))) if retry_after != float("inf") else "60"}
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Local rate limit exceeded.",
            headers=headers,
        )


async def _enforce_quota(quota: TokenQuota, client_hash: str) -> None:
    try:
        await quota.check(client_hash)
    except QuotaExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Local token budget exceeded: used={exc.used} budget={exc.budget}",
        )


# ---------- /health ----------

@router.get("/health", response_model=HealthResponse, tags=["health"])
async def health() -> HealthResponse:
    return HealthResponse()


# ---------- /v1/fuse (native) ----------

@router.post(
    "/v1/fuse",
    response_model=FusionResponse,
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        402: {"model": ErrorResponse},
        413: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
    },
    tags=["fusion"],
)
async def post_fuse(
    payload: FusionRequest,
    client_hash: str = Depends(require_api_key),
    orchestrator: FusionOrchestrator = Depends(get_orchestrator),
    cache: TTLCache = Depends(get_cache),
    limiter: TokenBucketLimiter = Depends(get_limiter),
    quota: TokenQuota = Depends(get_quota),
) -> FusionResponse:
    await _enforce_rate_limit(limiter, client_hash)
    await _enforce_quota(quota, client_hash)

    analysis_models, judge_model, critic_model = orchestrator._resolve_models(payload)  # noqa: SLF001

    cache_key: Optional[str] = None
    if payload.enable_cache:
        cache_key = make_cache_key(payload, analysis_models, judge_model, critic_model)
        cached = await cache.get(cache_key)
        if cached is not None:
            # Mutate cached.meta.cached on a copy so we don't poison the cache entry.
            stamped_meta = cached.meta.model_copy(update={"cached": True})
            return cached.model_copy(update={"meta": stamped_meta})

    response = await orchestrator.fuse(payload, client_hash)
    total_tokens = int(response.meta.usage.get("total_tokens") or 0)
    if total_tokens > 0:
        await quota.record(client_hash, total_tokens)

    if cache_key is not None:
        await cache.set(cache_key, response)
    return response


# ---------- /v1/models (OpenAI-compat) ----------

@router.get("/v1/models", tags=["openai-compat"])
async def list_models(client_hash: str = Depends(require_api_key)) -> Dict[str, Any]:
    now = int(time.time())
    data = []
    for name in FUSION_MODEL_ALIASES.keys():
        data.append(
            {
                "id": name,
                "object": "model",
                "created": now,
                "owned_by": "local-openrouter-fusion",
            }
        )
    return {"object": "list", "data": data}


# ---------- /v1/chat/completions (OpenAI-compat) ----------

def _coerce_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                # OpenAI-style content parts: {"type": "text", "text": "..."}
                t = p.get("text") or p.get("content")
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts)
    if content is None:
        return ""
    return str(content)


def _parse_fusion_model_name(
    model_name: str,
) -> tuple[Optional[FusionMode], Optional[List[str]], Optional[str]]:
    """Parse a custom fusion model id.

    Accepts:
        local-fusion                                     (mode: defer to ActiveConfig)
        local-fusion-code                                (mode: code)
        local-fusion-code:m1+m2+m3                       (analysis from name)
        local-fusion-code:m1+m2@judge                    (analysis + judge from name)
        local-fusion@judge                               (judge from name)

    Returns ``(mode_or_None, analysis_models_or_None, judge_or_None)``.
    A ``None`` mode means "use the runtime ActiveConfig".
    """
    m = _FUSION_INLINE_RE.match(model_name.strip())
    if not m:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unknown fusion model name '{model_name}'. "
                f"Use one of: {sorted(FUSION_MODEL_ALIASES.keys())}"
            ),
        )
    base = m.group("base")
    if base not in FUSION_MODEL_ALIASES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown fusion base model '{base}'.",
        )
    mode = FUSION_MODEL_ALIASES[base]
    analysis_raw = m.group("analysis")
    analysis_models: Optional[List[str]] = None
    if analysis_raw:
        analysis_models = [s.strip() for s in analysis_raw.split("+") if s.strip()]
        if not analysis_models:
            analysis_models = None
    judge_model = m.group("judge")
    if judge_model:
        judge_model = judge_model.strip() or None
    return mode, analysis_models, judge_model


def _build_fusion_request_from_openai(
    req: _OpenAIChatRequest, active: ActiveConfig
) -> FusionRequest:
    """Resolve a fusion request from an OpenAI-style payload.

    Resolution order for each field (first non-None wins):
        1. Request body explicit field (e.g. ``judge_model``)
        2. Inline ``model`` string parsing (e.g. ``...@judge``)
        3. Runtime ActiveConfig (mutated via the UI / admin API)
        4. ``Settings`` defaults (handled later by the orchestrator)
    """
    mode, parsed_analysis, parsed_judge = _parse_fusion_model_name(req.model)

    messages: List[Message] = []
    for raw in req.messages:
        text = _coerce_message_content(raw.content)
        if not text:
            continue
        messages.append(
            Message(
                role=raw.role,
                content=text,
                name=raw.name,
            )
        )
    if not messages:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No non-empty messages in request.",
        )

    # Mode: explicit > model-name suffix > active config
    if req.fusion_mode is not None:
        resolved_mode: FusionMode = req.fusion_mode
    elif mode is not None:
        resolved_mode = mode
    else:
        resolved_mode = active.mode

    analysis_models = req.analysis_models or parsed_analysis or active.analysis_models
    judge_model = req.judge_model or parsed_judge or active.judge_model
    critic_model = req.critic_model or active.critic_model

    temperature = (
        float(req.temperature) if req.temperature is not None else float(active.temperature)
    )
    max_tokens = int(req.max_tokens) if req.max_tokens is not None else int(active.max_tokens)
    enable_critique = (
        bool(req.enable_critique) if req.enable_critique is not None else bool(active.enable_critique)
    )
    enable_cache = (
        bool(req.enable_cache) if req.enable_cache is not None else bool(active.enable_cache)
    )

    payload: Dict[str, Any] = {
        "messages": [m.model_dump() for m in messages],
        "analysis_models": analysis_models,
        "judge_model": judge_model,
        "critic_model": critic_model,
        "mode": resolved_mode,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "include_candidates": bool(req.include_candidates) if req.include_candidates is not None else False,
        "include_trace": bool(req.include_trace) if req.include_trace is not None else False,
        "enable_critique": enable_critique,
        "enable_cache": enable_cache,
    }
    try:
        return FusionRequest(
            **{
                k: v
                for k, v in payload.items()
                if v is not None or k in ("analysis_models", "judge_model", "critic_model")
            }
        )
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=exc.errors(),
        )


def _to_openai_completion_response(
    model_name: str,
    fusion_response: FusionResponse,
) -> Dict[str, Any]:
    meta = fusion_response.meta
    usage_block = {}
    if meta.usage:
        usage_block = {
            "prompt_tokens": int(meta.usage.get("prompt_tokens") or 0),
            "completion_tokens": int(meta.usage.get("completion_tokens") or 0),
            "total_tokens": int(meta.usage.get("total_tokens") or 0),
        }
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": fusion_response.answer,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": usage_block,
        "x_local_fusion": {
            "analysis_models": meta.analysis_models,
            "judge_model": meta.judge_model,
            "critic_model": meta.critic_model,
            "mode": meta.mode,
            "cached": meta.cached,
            "latency_ms": meta.latency_ms,
            "judge_failed": meta.judge_failed,
            "critic_failed": meta.critic_failed,
            "fallback_reason": meta.fallback_reason,
        },
    }


def _to_openai_stream_chunks(
    model_name: str,
    fusion_response: FusionResponse,
) -> List[Dict[str, Any]]:
    cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    first = {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": fusion_response.answer},
                "finish_reason": None,
            }
        ],
    }
    final = {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }
        ],
    }
    return [first, final]


@router.post(
    "/v1/chat/completions",
    tags=["openai-compat"],
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
        402: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
    },
)
async def post_chat_completions(
    payload: _OpenAIChatRequest,
    client_hash: str = Depends(require_api_key),
    orchestrator: FusionOrchestrator = Depends(get_orchestrator),
    cache: TTLCache = Depends(get_cache),
    limiter: TokenBucketLimiter = Depends(get_limiter),
    quota: TokenQuota = Depends(get_quota),
    active_store: ActiveConfigStore = Depends(get_active_config_store),
):
    await _enforce_rate_limit(limiter, client_hash)
    await _enforce_quota(quota, client_hash)

    active = await active_store.get()
    fusion_request = _build_fusion_request_from_openai(payload, active)
    analysis_models, judge_model, critic_model = orchestrator._resolve_models(fusion_request)  # noqa: SLF001

    cache_key: Optional[str] = None
    fusion_response: Optional[FusionResponse] = None
    if fusion_request.enable_cache:
        cache_key = make_cache_key(fusion_request, analysis_models, judge_model, critic_model)
        cached = await cache.get(cache_key)
        if cached is not None:
            stamped_meta = cached.meta.model_copy(update={"cached": True})
            fusion_response = cached.model_copy(update={"meta": stamped_meta})

    if fusion_response is None:
        fusion_response = await orchestrator.fuse(fusion_request, client_hash)
        total_tokens = int(fusion_response.meta.usage.get("total_tokens") or 0)
        if total_tokens > 0:
            await quota.record(client_hash, total_tokens)
        if cache_key is not None:
            await cache.set(cache_key, fusion_response)

    if payload.stream:
        chunks = _to_openai_stream_chunks(payload.model, fusion_response)

        async def event_stream():
            for chunk in chunks:
                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return JSONResponse(_to_openai_completion_response(payload.model, fusion_response))


# ---------- /v1/admin/config (UI-backed runtime config) ----------

class _ConfigPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analysis_models: Optional[List[str]] = None
    judge_model: Optional[str] = None
    critic_model: Optional[str] = None
    mode: Optional[FusionMode] = None
    temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(default=None, ge=1, le=32_000)
    enable_critique: Optional[bool] = None
    enable_cache: Optional[bool] = None


@router.get("/v1/admin/config", tags=["admin"])
async def get_admin_config(
    client_hash: str = Depends(require_api_key),
    active_store: ActiveConfigStore = Depends(get_active_config_store),
) -> Dict[str, Any]:
    cfg = await active_store.get()
    return {"active": cfg.model_dump()}


@router.put("/v1/admin/config", tags=["admin"])
async def put_admin_config(
    patch: _ConfigPatch,
    client_hash: str = Depends(require_api_key),
    active_store: ActiveConfigStore = Depends(get_active_config_store),
) -> Dict[str, Any]:
    data = {k: v for k, v in patch.model_dump().items() if v is not None}
    # Build a fully-validated replacement by merging onto the current state.
    current = await active_store.get()
    merged = current.model_dump()
    merged.update(data)
    try:
        new_cfg = ActiveConfig(**merged)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=exc.errors())
    updated = await active_store.replace(new_cfg)
    return {"active": updated.model_dump()}


# ---------- Frontend UI (single-page config dashboard) ----------

_STATIC_DIR = Path(__file__).parent / "static"


@router.get("/", include_in_schema=False)
async def ui_index() -> FileResponse:
    """Serve the configuration dashboard. No auth at the page level; the
    UI calls the JSON APIs with the configured local API key."""
    index = _STATIC_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="UI bundle not found.")
    return FileResponse(str(index), media_type="text/html")


@router.get("/ui", include_in_schema=False)
async def ui_index_alias() -> FileResponse:
    return await ui_index()
