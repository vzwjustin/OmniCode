"""Fusion orchestrator: parallel analysis -> optional critique -> judge synthesis."""

from __future__ import annotations

import asyncio
import time
from typing import Any, List, Optional, Tuple

from fastapi import HTTPException, status

from .client import ChatCompletionResult, OpenRouterClient, OpenRouterError
from .config import Settings
from .logger import get_logger
from .prompts import (
    build_analysis_messages,
    build_critic_messages,
    build_judge_messages,
)
from .schemas import (
    FusionMeta,
    FusionMode,
    FusionRequest,
    FusionResponse,
    FusionTrace,
    ModelCandidate,
    UsageInfo,
)

logger = get_logger("local_fusion.orchestrator")

# Modes that pull in the critic stage by default when ``enable_critique`` is true.
_CRITIQUE_MODES: tuple[FusionMode, ...] = ("balanced", "deep", "code")


class FusionOrchestrator:
    def __init__(self, client: Any, settings: Settings) -> None:
        """``client`` is any object with an async ``chat_completion`` method.

        In production we pass a ``CompletionDispatcher`` so the orchestrator
        can transparently route to either OpenRouter or a local CLI based on
        the model id (``local:claude-code``, ``local:codex``, ``local:gemini``).
        """
        self.client = client
        self.settings = settings
        self._semaphore = asyncio.Semaphore(max(1, settings.MAX_MODEL_CONCURRENCY))

    # ----- public API -----
    async def fuse(
        self, request: FusionRequest, client_hash: str
    ) -> FusionResponse:
        started = time.monotonic()
        analysis_models, judge_model, critic_model = self._resolve_models(request)
        self._validate_prompt_size(request)

        logger.info(
            "fuse_start mode=%s caller=%s analysis_models=%s judge=%s critic=%s",
            request.mode,
            client_hash,
            analysis_models,
            judge_model,
            critic_model,
        )

        candidates = await self._run_analysis(
            request=request,
            analysis_models=analysis_models,
        )

        successful = [c for c in candidates if c.error is None and (c.content or "").strip()]
        if not successful:
            details = [
                f"{c.model}: {c.error or 'empty content'}" for c in candidates
            ]
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={
                    "error": "all_analysis_models_failed",
                    "candidates": details,
                },
            )

        critique_text: Optional[str] = None
        critic_failed = False
        if request.enable_critique and request.mode in _CRITIQUE_MODES and critic_model:
            critique_text, critic_failed = await self._run_critic(
                request=request,
                candidates=successful,
                critic_model=critic_model,
            )

        judge_text, judge_failed, judge_usage, fallback_reason = await self._run_judge(
            request=request,
            candidates=successful,
            critique_text=critique_text,
            judge_model=judge_model,
        )

        total_usage = self._aggregate_usage(
            candidates=candidates,
            critique_failed=critic_failed,
            critique_text=critique_text,
            judge_usage=judge_usage,
        )

        latency_ms = int((time.monotonic() - started) * 1000)
        meta = FusionMeta(
            analysis_models=analysis_models,
            judge_model=judge_model,
            critic_model=critic_model if (request.enable_critique and request.mode in _CRITIQUE_MODES) else None,
            mode=request.mode,
            cached=False,
            usage=total_usage,
            latency_ms=latency_ms,
            judge_failed=judge_failed,
            critic_failed=critic_failed,
            fallback_reason=fallback_reason,
        )

        trace: Optional[FusionTrace] = None
        if request.include_trace:
            notes: List[str] = []
            if judge_failed:
                notes.append("judge_failed: fell back to best candidate answer.")
            if critic_failed:
                notes.append("critic_failed: critique was skipped.")
            for cand in candidates:
                if cand.error:
                    notes.append(f"model_error[{cand.model}]: {cand.error}")
            trace = FusionTrace(
                judge_prompt_preview=None,
                critic_prompt_preview=None,
                notes=notes,
            )

        response = FusionResponse(
            answer=judge_text,
            candidates=candidates if request.include_candidates else None,
            critique=critique_text if request.include_candidates else None,
            trace=trace,
            meta=meta,
        )

        logger.info(
            "fuse_done caller=%s latency_ms=%d total_tokens=%s judge_failed=%s critic_failed=%s",
            client_hash,
            latency_ms,
            total_usage.get("total_tokens"),
            judge_failed,
            critic_failed,
        )
        return response

    # ----- internals -----
    def _resolve_models(
        self, request: FusionRequest
    ) -> Tuple[List[str], str, Optional[str]]:
        analysis = request.analysis_models or list(self.settings.DEFAULT_ANALYSIS_MODELS)
        if not analysis:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No analysis_models provided and no DEFAULT_ANALYSIS_MODELS configured.",
            )
        # Deduplicate while preserving order.
        seen: set[str] = set()
        deduped: List[str] = []
        for m in analysis:
            if m not in seen:
                deduped.append(m)
                seen.add(m)
        if len(deduped) > self.settings.MAX_ANALYSIS_MODELS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Too many analysis_models (>{self.settings.MAX_ANALYSIS_MODELS}).",
            )
        analysis = deduped

        judge = request.judge_model or self.settings.DEFAULT_JUDGE_MODEL
        critic = request.critic_model or self.settings.DEFAULT_CRITIC_MODEL or None
        if not judge:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No judge_model provided and no DEFAULT_JUDGE_MODEL configured.",
            )

        allowed = self.settings.ALLOWED_MODELS or []
        if allowed:
            allowed_set = set(allowed)
            bad = [m for m in analysis + [judge] + ([critic] if critic else []) if m not in allowed_set]
            if bad:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Model(s) not in ALLOWED_MODELS: {bad}",
                )
        return analysis, judge, critic

    def _validate_prompt_size(self, request: FusionRequest) -> None:
        total_chars = sum(len(m.content) for m in request.messages)
        if total_chars > self.settings.MAX_PROMPT_CHARS:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    f"Prompt too large: {total_chars} chars (limit "
                    f"{self.settings.MAX_PROMPT_CHARS})."
                ),
            )

    async def _run_analysis(
        self, request: FusionRequest, analysis_models: List[str]
    ) -> List[ModelCandidate]:
        messages = build_analysis_messages(request.messages)

        async def call_one(model: str) -> ModelCandidate:
            async with self._semaphore:
                try:
                    result = await self.client.chat_completion(
                        model=model,
                        messages=messages,
                        temperature=request.temperature,
                        max_tokens=request.max_tokens,
                    )
                except OpenRouterError as exc:
                    logger.warning("analysis_model_error model=%s err=%s", model, exc.message)
                    return ModelCandidate(
                        model=model,
                        content=None,
                        finish_reason=None,
                        usage=None,
                        latency_ms=0,
                        error=exc.message,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "analysis_model_unexpected model=%s err=%s",
                        model,
                        exc.__class__.__name__,
                    )
                    return ModelCandidate(
                        model=model,
                        content=None,
                        finish_reason=None,
                        usage=None,
                        latency_ms=0,
                        error=f"unexpected_error:{exc.__class__.__name__}",
                    )

                return ModelCandidate(
                    model=model,
                    content=self._truncate_for_candidate(result.content),
                    finish_reason=result.finish_reason,
                    usage=result.usage,
                    latency_ms=result.latency_ms,
                    error=None,
                )

        tasks = [asyncio.create_task(call_one(m)) for m in analysis_models]
        return await asyncio.gather(*tasks)

    def _truncate_for_candidate(self, content: str) -> str:
        limit = self.settings.MAX_CANDIDATE_CHARS_PER_MODEL
        if limit > 0 and len(content) > limit:
            return content[: limit - 24] + "\n…[truncated]"
        return content

    async def _run_critic(
        self,
        request: FusionRequest,
        candidates: List[ModelCandidate],
        critic_model: str,
    ) -> Tuple[Optional[str], bool]:
        messages = build_critic_messages(
            user_messages=request.messages,
            candidates=candidates,
            per_model_limit=self.settings.MAX_CANDIDATE_CHARS_PER_MODEL,
            final_context_limit=self.settings.MAX_FINAL_CONTEXT_CHARS,
        )
        try:
            result = await self.client.chat_completion(
                model=critic_model,
                messages=messages,
                temperature=min(0.4, request.temperature),
                max_tokens=min(2000, request.max_tokens),
            )
            return result.content.strip() or None, False
        except OpenRouterError as exc:
            logger.warning("critic_failed model=%s err=%s", critic_model, exc.message)
            return None, True
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "critic_unexpected model=%s err=%s",
                critic_model,
                exc.__class__.__name__,
            )
            return None, True

    async def _run_judge(
        self,
        request: FusionRequest,
        candidates: List[ModelCandidate],
        critique_text: Optional[str],
        judge_model: str,
    ) -> Tuple[str, bool, Optional[UsageInfo], Optional[str]]:
        messages = build_judge_messages(
            user_messages=request.messages,
            candidates=candidates,
            critique=critique_text,
            mode=request.mode,
            per_model_limit=self.settings.MAX_CANDIDATE_CHARS_PER_MODEL,
            final_context_limit=self.settings.MAX_FINAL_CONTEXT_CHARS,
        )
        try:
            result = await self.client.chat_completion(
                model=judge_model,
                messages=messages,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
            )
            text = (result.content or "").strip()
            if not text:
                raise OpenRouterError(502, "Judge returned empty content.")
            return text, False, result.usage, None
        except OpenRouterError as exc:
            logger.warning("judge_failed model=%s err=%s", judge_model, exc.message)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "judge_unexpected model=%s err=%s",
                judge_model,
                exc.__class__.__name__,
            )

        # Fallback: pick the longest non-empty candidate (proxy for "most detailed").
        best = self._best_fallback_candidate(candidates)
        if best is None:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Judge model failed and no candidate fallback available.",
            )
        return (
            best.content or "",
            True,
            None,
            f"judge_fallback_to:{best.model}",
        )

    @staticmethod
    def _best_fallback_candidate(
        candidates: List[ModelCandidate],
    ) -> Optional[ModelCandidate]:
        usable = [c for c in candidates if c.error is None and (c.content or "").strip()]
        if not usable:
            return None
        return max(usable, key=lambda c: len(c.content or ""))

    @staticmethod
    def _aggregate_usage(
        candidates: List[ModelCandidate],
        critique_failed: bool,
        critique_text: Optional[str],
        judge_usage: Optional[UsageInfo],
    ) -> dict:
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        have_any = False

        def add(u: Optional[UsageInfo]) -> None:
            nonlocal prompt_tokens, completion_tokens, total_tokens, have_any
            if not u:
                return
            have_any = True
            if u.prompt_tokens:
                prompt_tokens += int(u.prompt_tokens)
            if u.completion_tokens:
                completion_tokens += int(u.completion_tokens)
            if u.total_tokens:
                total_tokens += int(u.total_tokens)

        for c in candidates:
            add(c.usage)
        add(judge_usage)

        if not have_any:
            return {}

        # Some providers may omit total_tokens but supply the split.
        if total_tokens == 0 and (prompt_tokens or completion_tokens):
            total_tokens = prompt_tokens + completion_tokens

        return {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        }
