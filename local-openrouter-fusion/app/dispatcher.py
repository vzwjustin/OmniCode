"""Completion dispatcher: routes a model id to either OpenRouter or a local CLI.

This is the single seam the orchestrator depends on. Tests can substitute a
fake by providing any object with a ``chat_completion`` method matching the
signature below.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .client import ChatCompletionResult, OpenRouterClient
from .config import Settings
from .local_models import LocalModelRegistry, LocalModelRunner


class CompletionDispatcher:
    def __init__(
        self,
        openrouter: OpenRouterClient,
        settings: Settings,
        local_registry: Optional[LocalModelRegistry] = None,
    ) -> None:
        self.openrouter = openrouter
        self.settings = settings
        self.local_registry = local_registry or LocalModelRegistry(settings)
        self.local_runner = LocalModelRunner(self.local_registry, settings)

    def is_local(self, model_id: str) -> bool:
        return self.local_registry.is_local(model_id)

    async def chat_completion(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        temperature: float,
        max_tokens: int,
        timeout_seconds: Optional[float] = None,
    ) -> ChatCompletionResult:
        if self.is_local(model):
            return await self.local_runner.chat_completion(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout_seconds=timeout_seconds,
            )
        return await self.openrouter.chat_completion(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout_seconds=timeout_seconds,
        )

    async def close(self) -> None:
        await self.openrouter.close()
