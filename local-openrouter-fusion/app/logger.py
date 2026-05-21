"""Structured logger with secret redaction."""

from __future__ import annotations

import logging
import re
import sys
from typing import Any, Iterable

_SECRET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"sk-or-v1-[A-Za-z0-9_\-]+"),
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._\-]+", re.IGNORECASE),
]

_REDACTED = "[REDACTED]"


def redact(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        out = value
        for pat in _SECRET_PATTERNS:
            out = pat.sub(_REDACTED, out)
        return out
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(redact(item) for item in value)
    return value


class _RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D401
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)
        if record.args:
            if isinstance(record.args, tuple):
                record.args = tuple(redact(a) for a in record.args)
            elif isinstance(record.args, dict):
                record.args = {k: redact(v) for k, v in record.args.items()}
        return True


_CONFIGURED = False


def configure_logging(level: int = logging.INFO) -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    root = logging.getLogger()
    root.setLevel(level)

    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setLevel(level)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    handler.addFilter(_RedactingFilter())

    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    configure_logging()
    return logging.getLogger(name)


def safe_extra(items: Iterable[tuple[str, Any]]) -> dict[str, Any]:
    """Build a logging extras dict with redaction applied."""
    return {k: redact(v) for k, v in items}
