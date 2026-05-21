"""FastAPI entrypoint."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .cache import TTLCache
from .client import OpenRouterClient
from .config import get_settings
from .dispatcher import CompletionDispatcher
from .local_models import LocalModelRegistry
from .logger import configure_logging, get_logger
from .orchestrator import FusionOrchestrator
from .quota import TokenQuota
from .rate_limit import TokenBucketLimiter
from .routes import router
from .runtime_config import (
    ActiveConfigStore,
    default_active_config_from_settings,
)

logger = get_logger("local_fusion.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging()
    logger.info("Starting %s", settings.APP_NAME)

    openrouter_client = OpenRouterClient(settings=settings)
    local_registry = LocalModelRegistry(settings=settings)
    dispatcher = CompletionDispatcher(
        openrouter=openrouter_client,
        settings=settings,
        local_registry=local_registry,
    )
    orchestrator = FusionOrchestrator(client=dispatcher, settings=settings)
    cache = TTLCache(ttl_seconds=settings.CACHE_TTL_SECONDS)
    limiter = TokenBucketLimiter(
        capacity=settings.RATE_LIMIT_CAPACITY,
        refill_per_minute=settings.RATE_LIMIT_REFILL_PER_MINUTE,
    )
    quota = TokenQuota(budget_per_key=settings.LOCAL_TOKEN_BUDGET_PER_KEY)

    config_path: Path | None = None
    if settings.LOCAL_FUSION_CONFIG_PATH:
        config_path = Path(settings.LOCAL_FUSION_CONFIG_PATH).expanduser().resolve()
    active_store = ActiveConfigStore.load(
        path=config_path,
        fallback=default_active_config_from_settings(settings),
    )

    configured_locals = local_registry.configured_ids()
    if configured_locals:
        logger.info("Local CLI models enabled: %s", configured_locals)

    app.state.client = dispatcher
    app.state.openrouter_client = openrouter_client
    app.state.local_registry = local_registry
    app.state.orchestrator = orchestrator
    app.state.active_config = active_store
    app.state.cache = cache
    app.state.limiter = limiter
    app.state.quota = quota
    app.state.settings = settings
    try:
        yield
    finally:
        logger.info("Shutting down %s", settings.APP_NAME)
        await dispatcher.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.APP_NAME,
        version="0.1.0",
        description=(
            "Local OpenRouter Fusion Orchestrator. Calls multiple OpenRouter "
            "models in parallel and synthesizes one fused answer locally. "
            "Does NOT use OpenRouter's native fusion alias, plugin, or tool."
        ),
        lifespan=lifespan,
    )
    app.include_router(router)

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=422,
            content={"error": "invalid_request", "detail": exc.errors()},
        )

    @app.exception_handler(HTTPException)
    async def _http_handler(request: Request, exc: HTTPException):
        body: Dict[str, Any] = {"error": "http_error"}
        if isinstance(exc.detail, str):
            body["detail"] = exc.detail
        else:
            body["detail"] = exc.detail
        headers = exc.headers if exc.headers else None
        return JSONResponse(status_code=exc.status_code, content=body, headers=headers)

    return app


app = create_app()
