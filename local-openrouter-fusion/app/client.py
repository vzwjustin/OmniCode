"""HTTP client wrapper for OpenRouter /chat/completions."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx

from .config import Settings, get_settings
from .logger import get_logger
from .schemas import UsageInfo

logger = get_logger("local_fusion.client")


class OpenRouterError(Exception):
    """Raised for upstream errors that should map to a clean local error."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


@dataclass
class ChatCompletionResult:
    model: str
    content: str
    finish_reason: Optional[str]
    usage: Optional[UsageInfo]
    latency_ms: int
    raw_id: Optional[str] = None


class OpenRouterClient:
    """Thin async wrapper. Owns nothing about fusion semantics."""

    def __init__(
        self,
        settings: Optional[Settings] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.settings = settings or get_settings()
        self._owns_client = http_client is None
        self._client = http_client or self._build_client()

    def _build_client(self) -> httpx.AsyncClient:
        timeout = httpx.Timeout(
            self.settings.OPENROUTER_TIMEOUT_SECONDS,
            connect=min(30.0, self.settings.OPENROUTER_TIMEOUT_SECONDS),
        )
        limits = httpx.Limits(
            max_connections=max(16, self.settings.MAX_MODEL_CONCURRENCY * 2),
            max_keepalive_connections=max(8, self.settings.MAX_MODEL_CONCURRENCY),
        )
        return httpx.AsyncClient(
            base_url=self.settings.OPENROUTER_BASE_URL.rstrip("/"),
            timeout=timeout,
            limits=limits,
            headers={"User-Agent": f"{self.settings.APP_NAME}/0.1"},
        )

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    @property
    def http(self) -> httpx.AsyncClient:
        return self._client

    def _headers(self) -> Dict[str, str]:
        if not self.settings.OPENROUTER_API_KEY:
            raise OpenRouterError(500, "OPENROUTER_API_KEY is not configured.")
        return {
            "Authorization": f"Bearer {self.settings.OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": self.settings.APP_URL,
            "X-Title": self.settings.APP_NAME,
        }

    async def chat_completion(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        temperature: float,
        max_tokens: int,
        timeout_seconds: Optional[float] = None,
    ) -> ChatCompletionResult:
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": float(temperature),
            "max_tokens": int(max_tokens),
            "stream": False,
        }
        started = time.monotonic()
        request_timeout: Any = httpx.USE_CLIENT_DEFAULT
        if timeout_seconds is not None:
            request_timeout = httpx.Timeout(timeout_seconds)

        try:
            response = await self._client.post(
                "/chat/completions",
                json=payload,
                headers=self._headers(),
                timeout=request_timeout,
            )
        except httpx.TimeoutException as exc:
            raise OpenRouterError(504, f"Upstream timeout: {exc.__class__.__name__}") from exc
        except httpx.HTTPError as exc:
            raise OpenRouterError(
                502, f"Upstream transport error: {exc.__class__.__name__}"
            ) from exc

        latency_ms = int((time.monotonic() - started) * 1000)

        if response.status_code >= 400:
            self._raise_for_status(response)

        try:
            data = response.json()
        except ValueError as exc:
            raise OpenRouterError(502, "Upstream returned non-JSON body.") from exc

        return self._parse_completion(model, data, latency_ms)

    def _raise_for_status(self, response: httpx.Response) -> None:
        status_code = response.status_code
        upstream_msg = ""
        try:
            body = response.json()
            if isinstance(body, dict):
                err = body.get("error")
                if isinstance(err, dict):
                    upstream_msg = str(err.get("message") or "")
                elif isinstance(err, str):
                    upstream_msg = err
                elif body.get("message"):
                    upstream_msg = str(body.get("message"))
        except ValueError:
            upstream_msg = (response.text or "")[:200]

        # Always sanitize: don't pass through full upstream text verbatim.
        upstream_msg = upstream_msg.strip()[:240]

        if status_code == 401:
            raise OpenRouterError(502, "Upstream auth failed (OpenRouter 401).")
        if status_code == 402:
            raise OpenRouterError(502, "Upstream payment required (OpenRouter 402).")
        if status_code == 429:
            raise OpenRouterError(
                429, f"Upstream rate-limited (429){f': {upstream_msg}' if upstream_msg else ''}"
            )
        if 500 <= status_code < 600:
            raise OpenRouterError(
                502,
                f"Upstream server error ({status_code}){f': {upstream_msg}' if upstream_msg else ''}",
            )
        raise OpenRouterError(
            502,
            f"Upstream error ({status_code}){f': {upstream_msg}' if upstream_msg else ''}",
        )

    def _parse_completion(
        self, model: str, data: Dict[str, Any], latency_ms: int
    ) -> ChatCompletionResult:
        if not isinstance(data, dict):
            raise OpenRouterError(502, "Upstream returned non-object response.")

        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            raise OpenRouterError(502, "Upstream response missing choices.")

        first = choices[0] or {}
        message = first.get("message") or {}
        content = message.get("content")
        if isinstance(content, list):
            # Some providers return content as list-of-parts. Concatenate text parts.
            text_parts: List[str] = []
            for part in content:
                if isinstance(part, dict):
                    t = part.get("text") or part.get("content")
                    if isinstance(t, str):
                        text_parts.append(t)
            content = "".join(text_parts)
        if content is None:
            content = ""
        if not isinstance(content, str):
            content = str(content)

        finish_reason = first.get("finish_reason")
        usage_obj = data.get("usage")
        usage: Optional[UsageInfo] = None
        if isinstance(usage_obj, dict):
            try:
                usage = UsageInfo(**usage_obj)
            except Exception:  # noqa: BLE001
                usage = None

        return ChatCompletionResult(
            model=model,
            content=content,
            finish_reason=str(finish_reason) if finish_reason else None,
            usage=usage,
            latency_ms=latency_ms,
            raw_id=str(data.get("id")) if data.get("id") else None,
        )
