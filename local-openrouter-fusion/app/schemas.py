"""Pydantic v2 schemas for the local fusion API."""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

FusionMode = Literal["fast", "balanced", "deep", "code"]
MessageRole = Literal["system", "user", "assistant", "tool"]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class Message(_StrictModel):
    role: MessageRole
    content: str = Field(min_length=1, max_length=64_000)
    name: Optional[str] = Field(default=None, max_length=128)


class FusionRequest(_StrictModel):
    messages: List[Message] = Field(min_length=1, max_length=50)
    analysis_models: Optional[List[str]] = Field(default=None)
    judge_model: Optional[str] = Field(default=None)
    critic_model: Optional[str] = Field(default=None)
    mode: FusionMode = Field(default="balanced")
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int = Field(default=4000, ge=1, le=32_000)
    include_candidates: bool = Field(default=False)
    include_trace: bool = Field(default=False)
    enable_critique: bool = Field(default=True)
    enable_cache: bool = Field(default=True)

    @field_validator("analysis_models")
    @classmethod
    def _strip_models(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        cleaned = [m.strip() for m in v if m and m.strip()]
        if not cleaned:
            return None
        return cleaned

    @field_validator("judge_model", "critic_model")
    @classmethod
    def _strip_scalar_models(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        return v or None


class UsageInfo(BaseModel):
    model_config = ConfigDict(extra="allow")

    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


class ModelCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str
    content: Optional[str] = None
    finish_reason: Optional[str] = None
    usage: Optional[UsageInfo] = None
    latency_ms: int = 0
    error: Optional[str] = None


class FusionMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analysis_models: List[str]
    judge_model: str
    critic_model: Optional[str] = None
    mode: FusionMode
    cached: bool = False
    usage: Dict[str, Any] = Field(default_factory=dict)
    latency_ms: int = 0
    judge_failed: bool = False
    critic_failed: bool = False
    fallback_reason: Optional[str] = None


class FusionTrace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    judge_prompt_preview: Optional[str] = None
    critic_prompt_preview: Optional[str] = None
    notes: List[str] = Field(default_factory=list)


class FusionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: str
    candidates: Optional[List[ModelCandidate]] = None
    critique: Optional[str] = None
    trace: Optional[FusionTrace] = None
    meta: FusionMeta


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str = "operational"
    mode: str = "local-fusion-orchestration"
    native_openrouter_fusion: bool = False


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: str
    detail: Optional[str] = None
