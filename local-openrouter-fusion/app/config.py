"""Application configuration loaded from environment variables."""

from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from typing_extensions import Annotated


def _split_csv(value: str | List[str] | None) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [item.strip() for item in value if str(item).strip()]
    return [item.strip() for item in str(value).split(",") if item.strip()]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    OPENROUTER_API_KEY: str = Field(default="")
    OPENROUTER_BASE_URL: str = Field(default="https://openrouter.ai/api/v1")
    OPENROUTER_TIMEOUT_SECONDS: float = Field(default=240.0, ge=1.0, le=900.0)

    APP_URL: str = Field(default="http://localhost:8000")
    APP_NAME: str = Field(default="Local OpenRouter Fusion Orchestrator")

    SERVICE_API_KEYS: Annotated[List[str], NoDecode] = Field(default_factory=list)

    RATE_LIMIT_CAPACITY: int = Field(default=20, ge=1, le=10000)
    RATE_LIMIT_REFILL_PER_MINUTE: float = Field(default=10.0, ge=0.0, le=10000.0)

    MAX_PROMPT_CHARS: int = Field(default=24000, ge=1, le=1_000_000)
    MAX_ANALYSIS_MODELS: int = Field(default=8, ge=1, le=64)
    MAX_MODEL_CONCURRENCY: int = Field(default=8, ge=1, le=64)
    MAX_CANDIDATE_CHARS_PER_MODEL: int = Field(default=12000, ge=256, le=1_000_000)
    MAX_FINAL_CONTEXT_CHARS: int = Field(default=48000, ge=1024, le=2_000_000)

    CACHE_TTL_SECONDS: int = Field(default=600, ge=0, le=24 * 60 * 60)
    LOCAL_TOKEN_BUDGET_PER_KEY: int = Field(default=1_000_000, ge=0)

    DEFAULT_ANALYSIS_MODELS: Annotated[List[str], NoDecode] = Field(
        default_factory=lambda: [
            "anthropic/claude-sonnet-4.5",
            "openai/gpt-4.1",
            "google/gemini-2.5-pro",
            "x-ai/grok-4",
        ]
    )
    DEFAULT_JUDGE_MODEL: str = Field(default="anthropic/claude-opus-4.1")
    DEFAULT_CRITIC_MODEL: str = Field(default="anthropic/claude-sonnet-4.5")

    ALLOWED_MODELS: Annotated[List[str], NoDecode] = Field(default_factory=list)

    # --- Local CLI model adapters (optional) ---
    LOCAL_MODEL_TIMEOUT_SECONDS: float = Field(default=180.0, ge=1.0, le=1800.0)
    LOCAL_CLAUDE_CODE_CMD: str = Field(default="")
    LOCAL_CLAUDE_CODE_ARGS: Annotated[List[str], NoDecode] = Field(default_factory=list)
    LOCAL_CODEX_CMD: str = Field(default="")
    LOCAL_CODEX_ARGS: Annotated[List[str], NoDecode] = Field(default_factory=list)
    LOCAL_GEMINI_CMD: str = Field(default="")
    LOCAL_GEMINI_ARGS: Annotated[List[str], NoDecode] = Field(default_factory=list)

    # Path where the UI-editable runtime config is persisted. Empty = no persistence.
    LOCAL_FUSION_CONFIG_PATH: str = Field(default="./fusion_config.json")

    @field_validator(
        "SERVICE_API_KEYS",
        "DEFAULT_ANALYSIS_MODELS",
        "ALLOWED_MODELS",
        "LOCAL_CLAUDE_CODE_ARGS",
        "LOCAL_CODEX_ARGS",
        "LOCAL_GEMINI_ARGS",
        mode="before",
    )
    @classmethod
    def _parse_csv_lists(cls, v):  # noqa: ANN001
        return _split_csv(v)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Reset the cached settings (used by tests)."""
    get_settings.cache_clear()
