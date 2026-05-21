/**
 * Prompt builders for the local-fusion orchestrator.
 *
 * Three roles:
 *   - analysis: each candidate model answers the user's prompt independently.
 *   - critic:   compares the candidate answers, surfaces contradictions/risks.
 *   - judge:    synthesizes a single final answer for the user.
 */

import type { FusionConfigData } from "@/lib/db/fusionConfig";

export const ANALYSIS_SYSTEM_PROMPT =
  "You are one expert model inside a local multi-model fusion system. " +
  "Give your best independent answer. Do not mention that other models exist. " +
  "Be precise, practical, and identify assumptions. For code tasks, include " +
  "concrete implementation details and risks.";

export const CRITIC_SYSTEM_PROMPT =
  "You are the critic in a local multi-model fusion system. Compare the candidate " +
  "answers against the user request. Identify contradictions, weak reasoning, " +
  "missing requirements, hallucination risks, security issues, implementation " +
  "risks, and the strongest ideas to preserve. Do not produce the final user " +
  "answer. Produce compact judge-facing notes.";

export const JUDGE_SYSTEM_PROMPT_BASE =
  "You are the final synthesis model in a local multi-model fusion system. " +
  "Your job is to produce ONE best final answer for the user. Use the candidate " +
  "answers and critique notes as raw material, not as content to blindly merge. " +
  "Resolve contradictions. Remove duplicated fluff. Prefer correctness, " +
  "implementation clarity, and safety. Do not mention internal deliberation " +
  "unless the caller requested trace output. Return the final answer directly.";

export const JUDGE_CODE_ADDENDUM =
  "The user is likely going to paste your answer into Claude Code. Produce a " +
  "build-ready response. Include exact architecture, files to create/edit, " +
  "validation rules, tests, and acceptance criteria. Avoid vague TODOs. Any " +
  "TODO must be converted into an implemented feature or explicitly removed.";

const PER_CANDIDATE_CHAR_LIMIT = 12_000;
const FINAL_CONTEXT_CHAR_LIMIT = 48_000;

interface ChatMessage {
  role: string;
  content: string | unknown;
  name?: string;
}

export interface CandidateForPrompting {
  model: string;
  content: string | null;
  error: string | null;
}

function truncate(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 64)) + "\n…[truncated]";
}

function coerceContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === "string") {
        parts.push(p);
      } else if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        const t =
          typeof o.text === "string" ? o.text : typeof o.content === "string" ? o.content : "";
        if (t) parts.push(t);
      }
    }
    return parts.join("");
  }
  if (content == null) return "";
  return String(content);
}

function renderUserBrief(messages: ChatMessage[], limit: number): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = coerceContent(m.content);
    if (!text) continue;
    if (m.role === "system") parts.push(`[system instructions]\n${text}`);
    else parts.push(`[${m.role}]\n${text}`);
  }
  return truncate(parts.join("\n\n"), limit);
}

function renderCandidates(candidates: CandidateForPrompting[], perModelLimit: number): string {
  const out: string[] = [];
  candidates.forEach((c, i) => {
    const header = `--- Candidate ${i + 1} (model=${c.model})`;
    if (c.error) {
      out.push(`${header} ERROR: ${c.error} ---\n[no content]`);
      return;
    }
    out.push(`${header} ---\n${truncate(c.content ?? "", perModelLimit)}`);
  });
  return out.join("\n\n");
}

export function buildAnalysisMessages(userMessages: ChatMessage[]): ChatMessage[] {
  const hasSystem = userMessages.some((m) => m.role === "system");
  const out: ChatMessage[] = [];
  if (!hasSystem) {
    out.push({ role: "system", content: ANALYSIS_SYSTEM_PROMPT });
  }
  for (const m of userMessages) {
    out.push({ role: m.role, content: coerceContent(m.content) });
  }
  return out;
}

export function buildCriticMessages(
  userMessages: ChatMessage[],
  candidates: CandidateForPrompting[]
): ChatMessage[] {
  const brief = renderUserBrief(userMessages, Math.floor(FINAL_CONTEXT_CHAR_LIMIT / 2));
  const rendered = renderCandidates(candidates, PER_CANDIDATE_CHAR_LIMIT);
  const userContent = truncate(
    [
      "Original user request:",
      brief,
      "",
      "Candidate answers from independent expert models:",
      rendered,
      "",
      "Write compact judge-facing notes:",
      "- contradictions between candidates",
      "- weak or unsupported claims",
      "- missing requirements relative to the user request",
      "- security / correctness risks",
      "- strongest ideas worth keeping",
      "Output plain text, no preamble.",
    ].join("\n"),
    FINAL_CONTEXT_CHAR_LIMIT
  );
  return [
    { role: "system", content: CRITIC_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

export function buildJudgeMessages(
  userMessages: ChatMessage[],
  candidates: CandidateForPrompting[],
  critique: string | null,
  mode: FusionConfigData["mode"]
): ChatMessage[] {
  const systemPrompt =
    mode === "code"
      ? `${JUDGE_SYSTEM_PROMPT_BASE} ${JUDGE_CODE_ADDENDUM}`
      : JUDGE_SYSTEM_PROMPT_BASE;

  const brief = renderUserBrief(userMessages, Math.floor(FINAL_CONTEXT_CHAR_LIMIT / 2));
  const rendered = renderCandidates(candidates, PER_CANDIDATE_CHAR_LIMIT);
  const critiqueBlock = critique
    ? "\n\nCritique notes (from the critic model, judge-facing only):\n" +
      truncate(critique, Math.floor(FINAL_CONTEXT_CHAR_LIMIT / 3))
    : "";

  let directive: string;
  if (mode === "fast") {
    directive =
      "Synthesize the single best final answer for the user. Be direct, concise, and correct.";
  } else if (mode === "deep") {
    directive =
      "Produce the highest-confidence final answer. Resolve all contradictions explicitly. " +
      "Cover missing pieces, surface assumptions, and prefer correctness over brevity.";
  } else if (mode === "code") {
    directive =
      "Produce an implementation-ready final answer. Include a file-level plan, exact patch " +
      "strategy, commands to run, tests, and acceptance criteria. Replace any vague TODO with " +
      "the concrete implementation.";
  } else {
    directive =
      "Synthesize one clean final answer. Resolve contradictions, drop duplicated material, " +
      "and keep only what is correct and useful.";
  }

  const userContent = truncate(
    [
      "Original user request:",
      brief,
      "",
      "Candidate answers from independent expert models:",
      rendered,
      critiqueBlock,
      "",
      directive,
      "Return the final answer to the user directly. Do not describe the deliberation process.",
    ]
      .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
      .join("\n"),
    FINAL_CONTEXT_CHAR_LIMIT
  );

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}
