"""Prompt builders for the fusion pipeline."""

from __future__ import annotations

from typing import List, Optional

from .schemas import FusionMode, Message, ModelCandidate

ANALYSIS_SYSTEM_PROMPT = (
    "You are one expert model inside a local multi-model fusion system. "
    "Give your best independent answer. Do not mention that other models exist. "
    "Be precise, practical, and identify assumptions. For code tasks, include "
    "concrete implementation details and risks."
)

CRITIC_SYSTEM_PROMPT = (
    "You are the critic in a local multi-model fusion system. Compare the candidate "
    "answers against the user request. Identify contradictions, weak reasoning, "
    "missing requirements, hallucination risks, security issues, implementation "
    "risks, and the strongest ideas to preserve. Do not produce the final user "
    "answer. Produce compact judge-facing notes."
)

JUDGE_SYSTEM_PROMPT_BASE = (
    "You are the final synthesis model in a local multi-model fusion system. "
    "Your job is to produce ONE best final answer for the user. Use the candidate "
    "answers and critique notes as raw material, not as content to blindly merge. "
    "Resolve contradictions. Remove duplicated fluff. Prefer correctness, "
    "implementation clarity, and safety. Do not mention internal deliberation "
    "unless the caller requested trace output. Return the final answer directly."
)

JUDGE_CODE_ADDENDUM = (
    "The user is likely going to paste your answer into Claude Code. Produce a "
    "build-ready response. Include exact architecture, files to create/edit, "
    "validation rules, tests, and acceptance criteria. Avoid vague TODOs. Any "
    "TODO must be converted into an implemented feature or explicitly removed."
)


def _truncate(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    head = text[: max(0, limit - 64)]
    return head + "\n…[truncated]"


def build_analysis_messages(
    user_messages: List[Message],
) -> List[dict]:
    """Build the message list sent to each analysis model.

    A system prompt is prepended only if the caller did not supply one,
    so caller-provided instructions take priority.
    """
    has_system = any(m.role == "system" for m in user_messages)
    out: List[dict] = []
    if not has_system:
        out.append({"role": "system", "content": ANALYSIS_SYSTEM_PROMPT})
    for m in user_messages:
        out.append({"role": m.role, "content": m.content})
    return out


def _render_candidates(candidates: List[ModelCandidate], per_model_limit: int) -> str:
    parts: List[str] = []
    for i, c in enumerate(candidates, start=1):
        header = f"--- Candidate {i} (model={c.model})"
        if c.error:
            parts.append(f"{header} ERROR: {c.error} ---\n[no content]")
            continue
        body = _truncate(c.content or "", per_model_limit)
        parts.append(f"{header} ---\n{body}")
    return "\n\n".join(parts)


def _render_user_brief(user_messages: List[Message], limit: int) -> str:
    pieces: List[str] = []
    for m in user_messages:
        if m.role == "system":
            pieces.append(f"[system instructions]\n{m.content}")
        else:
            pieces.append(f"[{m.role}]\n{m.content}")
    return _truncate("\n\n".join(pieces), limit)


def build_critic_messages(
    user_messages: List[Message],
    candidates: List[ModelCandidate],
    per_model_limit: int,
    final_context_limit: int,
) -> List[dict]:
    brief = _render_user_brief(user_messages, final_context_limit // 2)
    rendered = _render_candidates(candidates, per_model_limit)
    user_content = (
        "Original user request:\n"
        f"{brief}\n\n"
        "Candidate answers from independent expert models:\n"
        f"{rendered}\n\n"
        "Write compact judge-facing notes:\n"
        "- contradictions between candidates\n"
        "- weak or unsupported claims\n"
        "- missing requirements relative to the user request\n"
        "- security / correctness risks\n"
        "- strongest ideas worth keeping\n"
        "Output plain text, no preamble."
    )
    user_content = _truncate(user_content, final_context_limit)
    return [
        {"role": "system", "content": CRITIC_SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]


def build_judge_messages(
    user_messages: List[Message],
    candidates: List[ModelCandidate],
    critique: Optional[str],
    mode: FusionMode,
    per_model_limit: int,
    final_context_limit: int,
) -> List[dict]:
    system_prompt = JUDGE_SYSTEM_PROMPT_BASE
    if mode == "code":
        system_prompt = JUDGE_SYSTEM_PROMPT_BASE + " " + JUDGE_CODE_ADDENDUM

    brief = _render_user_brief(user_messages, final_context_limit // 2)
    rendered = _render_candidates(candidates, per_model_limit)
    critic_block = ""
    if critique:
        critic_block = (
            "\n\nCritique notes (from the critic model, judge-facing only):\n"
            f"{_truncate(critique, final_context_limit // 3)}"
        )

    if mode == "fast":
        directive = (
            "Synthesize the single best final answer for the user. Be direct, "
            "concise, and correct."
        )
    elif mode == "deep":
        directive = (
            "Produce the highest-confidence final answer. Resolve all "
            "contradictions explicitly. Cover missing pieces, surface assumptions, "
            "and prefer correctness over brevity."
        )
    elif mode == "code":
        directive = (
            "Produce an implementation-ready final answer. Include a file-level "
            "plan, exact patch strategy, commands to run, tests, and acceptance "
            "criteria. Replace any vague TODO with the concrete implementation."
        )
    else:  # balanced
        directive = (
            "Synthesize one clean final answer. Resolve contradictions, drop "
            "duplicated material, and keep only what is correct and useful."
        )

    user_content = (
        "Original user request:\n"
        f"{brief}\n\n"
        "Candidate answers from independent expert models:\n"
        f"{rendered}"
        f"{critic_block}\n\n"
        f"{directive}\n"
        "Return the final answer to the user directly. Do not describe the "
        "deliberation process."
    )
    user_content = _truncate(user_content, final_context_limit)
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]
