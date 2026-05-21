"""Local CLI model adapters.

Allows mixing local CLI assistants (Claude Code, OpenAI Codex CLI, etc.) into
the fusion pipeline alongside remote OpenRouter models.

Model id syntax recognized here:
    local:claude-code    -> spawn the configured Claude Code CLI
    local:codex          -> spawn the configured Codex CLI

The prompt is built from the chat messages and written to the child process
on stdin. We NEVER use ``shell=True`` and we NEVER interpolate the prompt
into argv strings — that prevents shell-injection regardless of caller
input.
"""

from __future__ import annotations

import asyncio
import shutil
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .client import ChatCompletionResult, OpenRouterError
from .config import Settings
from .logger import get_logger

logger = get_logger("local_fusion.local_models")

LOCAL_PREFIX = "local:"

# Known short ids -> internal slug used to look up command + args in settings.
_KNOWN_LOCAL_IDS: Dict[str, str] = {
    "local:claude-code": "claude-code",
    "local:claude": "claude-code",
    "local:codex": "codex",
    "local:gemini": "gemini",
}


@dataclass(frozen=True)
class LocalAdapterConfig:
    slug: str
    cmd: str
    args: tuple[str, ...]


class LocalModelRegistry:
    """Maps a ``local:<id>`` model id to an executable command + argv."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._adapters: Dict[str, LocalAdapterConfig] = {}
        self._register("claude-code", settings.LOCAL_CLAUDE_CODE_CMD, settings.LOCAL_CLAUDE_CODE_ARGS)
        self._register("codex", settings.LOCAL_CODEX_CMD, settings.LOCAL_CODEX_ARGS)
        self._register("gemini", settings.LOCAL_GEMINI_CMD, settings.LOCAL_GEMINI_ARGS)

    def _register(self, slug: str, cmd: str, args: List[str]) -> None:
        cmd = (cmd or "").strip()
        if not cmd:
            return
        self._adapters[slug] = LocalAdapterConfig(
            slug=slug,
            cmd=cmd,
            args=tuple(a for a in args if a),
        )

    def is_local(self, model_id: str) -> bool:
        return isinstance(model_id, str) and model_id.startswith(LOCAL_PREFIX)

    def resolve(self, model_id: str) -> Optional[LocalAdapterConfig]:
        slug = _KNOWN_LOCAL_IDS.get(model_id)
        if slug:
            return self._adapters.get(slug)
        # Allow direct slug lookup for forward-compat: local:<slug>
        if model_id.startswith(LOCAL_PREFIX):
            return self._adapters.get(model_id[len(LOCAL_PREFIX):])
        return None

    def configured_ids(self) -> List[str]:
        out: List[str] = []
        for known_id, slug in _KNOWN_LOCAL_IDS.items():
            if slug in self._adapters and known_id not in out:
                out.append(known_id)
        return out


def messages_to_prompt(messages: List[Dict[str, Any]]) -> str:
    """Flatten chat messages into a single prompt for a CLI assistant."""
    parts: List[str] = []
    for m in messages:
        role = str(m.get("role") or "user").lower()
        content = m.get("content")
        if isinstance(content, list):
            text_chunks: List[str] = []
            for p in content:
                if isinstance(p, dict):
                    t = p.get("text") or p.get("content")
                    if isinstance(t, str):
                        text_chunks.append(t)
                elif isinstance(p, str):
                    text_chunks.append(p)
            content = "".join(text_chunks)
        if content is None:
            continue
        if role == "system":
            parts.append(f"<<SYSTEM>>\n{content}")
        elif role == "assistant":
            parts.append(f"<<ASSISTANT>>\n{content}")
        else:
            parts.append(f"<<{role.upper()}>>\n{content}")
    return "\n\n".join(parts).strip() + "\n"


class LocalModelRunner:
    """Executes local CLI adapters as ``chat_completion``-compatible calls."""

    def __init__(self, registry: LocalModelRegistry, settings: Settings) -> None:
        self.registry = registry
        self.settings = settings

    async def chat_completion(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        temperature: float,  # accepted but ignored by local CLIs
        max_tokens: int,     # accepted but ignored by local CLIs
        timeout_seconds: Optional[float] = None,
    ) -> ChatCompletionResult:
        adapter = self.registry.resolve(model)
        if adapter is None:
            raise OpenRouterError(
                400,
                f"Local model '{model}' is not configured. "
                f"Set the matching LOCAL_*_CMD env var.",
            )

        resolved_cmd = shutil.which(adapter.cmd) or adapter.cmd
        if not shutil.which(resolved_cmd) and "/" not in resolved_cmd:
            raise OpenRouterError(
                502,
                f"Local model CLI not found on PATH: '{adapter.cmd}'.",
            )

        prompt = messages_to_prompt(messages)
        timeout = timeout_seconds or self.settings.LOCAL_MODEL_TIMEOUT_SECONDS

        argv = [resolved_cmd, *adapter.args]
        started = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise OpenRouterError(
                502, f"Local model CLI not executable: {adapter.cmd}"
            ) from exc
        except OSError as exc:
            raise OpenRouterError(
                502, f"Failed to spawn local model '{model}': {exc.__class__.__name__}"
            ) from exc

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(input=prompt.encode("utf-8")),
                timeout=timeout,
            )
        except asyncio.TimeoutError as exc:
            with _suppress_exceptions():
                proc.kill()
                await proc.wait()
            raise OpenRouterError(504, f"Local model '{model}' timed out.") from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        returncode = proc.returncode if proc.returncode is not None else -1
        stdout = stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
        stderr = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""

        if returncode != 0:
            # Truncate stderr; do not leak full output back to clients.
            tail = (stderr or stdout).strip().splitlines()[-3:]
            snippet = " | ".join(line[:160] for line in tail) or "no stderr"
            logger.warning(
                "local_model_failed model=%s rc=%d stderr=%s",
                model,
                returncode,
                snippet[:240],
            )
            raise OpenRouterError(
                502,
                f"Local model '{model}' exited with code {returncode}: {snippet[:160]}",
            )

        content = stdout.strip()
        if not content:
            raise OpenRouterError(502, f"Local model '{model}' returned empty output.")

        return ChatCompletionResult(
            model=model,
            content=content,
            finish_reason="stop",
            usage=None,  # local CLIs don't report OpenRouter-style usage
            latency_ms=latency_ms,
        )


class _suppress_exceptions:
    def __enter__(self):  # noqa: D401
        return self

    def __exit__(self, exc_type, exc, tb):  # noqa: D401
        return True
