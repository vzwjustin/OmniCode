"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Card,
  Button,
  Input,
  Badge,
  EmptyState,
  RelativeTime,
  CopyButton,
  Kbd,
  ConfirmModal,
} from "@/shared/components";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";

// Real-time refresh tunables. Two cadences because the endpoints have very
// different cost characteristics:
//
//   LIST_POLL_MS — GET /api/v1/agents/tasks is a pure SQLite read; no upstream
//   API call, no quota burn. Safe to poll aggressively.
//
//   DETAIL_POLL_MS — GET /api/v1/agents/tasks/[id] DOES call the upstream
//   provider (Jules issues two parallel fetches: /sessions/{id} and
//   /sessions/{id}/activities). Keep this conservative to respect rate limits.
//
// Polling auto-stops when the selected task is in a terminal state
// (completed/failed/cancelled) and pauses while the tab is hidden.
const LIST_POLL_MS = 5000;
const DETAIL_POLL_MS = 4000;
const TERMINAL_STATUSES: readonly CloudAgentTask["status"][] = ["completed", "failed", "cancelled"];

interface CloudAgentTask {
  id: string;
  providerId: string;
  status: "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
  prompt: string;
  source: {
    repoName?: string;
    repoUrl?: string;
    branch?: string;
  };
  createdAt: string;
  updatedAt: string;
  result?: Record<string, unknown> | null;
  error?: string;
  activities: Array<{
    id: string;
    type: "plan" | "command" | "code_change" | "message" | "error" | "completion";
    content: string;
    timestamp: string;
  }>;
}

const CLOUD_AGENTS = [
  {
    id: "jules",
    name: "Jules",
    provider: "Google",
    description: "Google's autonomous coding agent",
    icon: "🟡",
    color: "bg-yellow-500/10 text-yellow-600",
  },
  {
    id: "devin",
    name: "Devin",
    provider: "Cognition",
    description: "Cognition's AI software engineer",
    icon: "🔵",
    color: "bg-blue-500/10 text-blue-600",
  },
  {
    id: "codex-cloud",
    name: "Codex Cloud",
    provider: "OpenAI",
    description: "OpenAI's cloud-based coding agent",
    icon: "⚡",
    color: "bg-emerald-500/10 text-emerald-600",
  },
];

export default function CloudAgentsPage() {
  const [tasks, setTasks] = useState<CloudAgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selectedTask, setSelectedTask] = useState<CloudAgentTask | null>(null);
  const [newTask, setNewTask] = useState({
    providerId: "jules",
    prompt: "",
    repoName: "",
    repoUrl: "",
    branch: "main",
    autoCreatePr: true,
  });
  const [messageInput, setMessageInput] = useState("");
  const [taskPendingDelete, setTaskPendingDelete] = useState<CloudAgentTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  const t = useTranslations("cloudAgents");
  const notify = useNotificationStore();

  const showApiError = useCallback(
    async (res: Response, fallback: string) => {
      let message = fallback;
      try {
        const data = await res.clone().json();
        if (data && typeof data.error === "string" && data.error.trim()) {
          message = data.error;
        }
      } catch {
        try {
          const text = await res.clone().text();
          if (text.trim()) message = text;
        } catch {
          /* ignore */
        }
      }
      notify.error(message, `Request failed (${res.status})`);
    },
    [notify]
  );

  const upsertTask = useCallback((task: CloudAgentTask) => {
    const safeTask: CloudAgentTask = {
      ...task,
      activities: Array.isArray(task.activities) ? task.activities : [],
    };
    setTasks((prev) => {
      const exists = prev.some((current) => current.id === safeTask.id);
      return exists
        ? prev.map((current) => (current.id === safeTask.id ? safeTask : current))
        : [safeTask, ...prev];
    });
    setSelectedTask((current) => (current?.id === safeTask.id ? safeTask : current));
  }, []);

  // Last-successful refresh timestamps for the live indicator. We only update
  // these on successful fetches so a transient network blip doesn't make the
  // UI appear fresher than it actually is.
  const [lastListRefresh, setLastListRefresh] = useState<number | null>(null);
  const [lastDetailRefresh, setLastDetailRefresh] = useState<number | null>(null);

  // In-flight guards. The list poll is allowed to skip a tick if a previous
  // fetch is still running; the detail poll uses an AbortController so we can
  // cancel in-flight upstream requests when the user switches tasks (avoids a
  // late upstream response clobbering a freshly-selected task's state).
  const listFetchInFlightRef = useRef(false);
  const detailFetchAbortRef = useRef<AbortController | null>(null);

  // 1s ticker so the "updated Xs ago" relative timestamp re-renders smoothly
  // between poll ticks. Tied to a state bump so React picks up the change.
  const [, setTickerNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTickerNonce((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // `silent` means: don't surface 4xx/5xx as a toast (we don't want every
  // background poll to spam notifications on transient errors). The initial
  // load + manual refresh still surface errors so users aren't left guessing.
  const fetchTasks = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (listFetchInFlightRef.current) return;
      listFetchInFlightRef.current = true;
      try {
        const res = await fetch("/api/v1/agents/tasks");
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data.data) ? (data.data as CloudAgentTask[]) : [];
          setTasks(
            list.map((t) => ({
              ...t,
              activities: Array.isArray(t.activities) ? t.activities : [],
            }))
          );
          setLastListRefresh(Date.now());
        } else if (!opts?.silent) {
          await showApiError(res, "Failed to load cloud agent tasks");
        }
      } catch (err) {
        if (!opts?.silent) {
          console.error("Failed to fetch tasks:", err);
          notify.error(
            err instanceof Error ? err.message : "Network error while loading tasks",
            "Connection failed"
          );
        }
      } finally {
        setLoading(false);
        listFetchInFlightRef.current = false;
      }
    },
    [notify, showApiError]
  );

  // Single-task refresh — hits the per-id endpoint which, on the server side,
  // calls agent.getStatus() against the upstream provider (Jules: two parallel
  // requests to /sessions/{id} + /sessions/{id}/activities). We use an
  // AbortController so switching tasks immediately cancels the previous
  // upstream call rather than letting it race the new selection.
  const fetchSelectedTask = useCallback(
    async (taskId: string, opts?: { silent?: boolean }) => {
      // Cancel any prior in-flight detail fetch before starting a new one.
      detailFetchAbortRef.current?.abort();
      const controller = new AbortController();
      detailFetchAbortRef.current = controller;
      try {
        const res = await fetch(`/api/v1/agents/tasks/${taskId}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.data) {
            upsertTask(data.data);
            setLastDetailRefresh(Date.now());
          }
        } else if (!opts?.silent) {
          await showApiError(res, "Failed to refresh task");
        }
      } catch (err) {
        // AbortError is expected on task-switch / unmount — never surface it.
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!opts?.silent) {
          console.error("Failed to fetch task detail:", err);
        }
      }
    },
    [showApiError, upsertTask]
  );

  // Initial load. Subsequent refreshes happen in the polling effect below.
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // List polling. Skips silently when the tab is hidden so a backgrounded
  // dashboard doesn't keep hammering the API.
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      fetchTasks({ silent: true });
    }, LIST_POLL_MS);
    return () => clearInterval(id);
  }, [fetchTasks]);

  // Detail polling. Only runs when a task is selected AND it's in a
  // non-terminal state. The cleanup function cancels any in-flight upstream
  // request when the selected task changes (or when it transitions into a
  // terminal state, which removes the polling dependency).
  useEffect(() => {
    if (!selectedTask) return;
    if (TERMINAL_STATUSES.includes(selectedTask.status)) return;

    const taskId = selectedTask.id;
    // Fire one fetch immediately so the user sees fresh data without waiting
    // up to DETAIL_POLL_MS after selecting a task.
    fetchSelectedTask(taskId, { silent: true });

    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      fetchSelectedTask(taskId, { silent: true });
    }, DETAIL_POLL_MS);

    return () => {
      clearInterval(id);
      detailFetchAbortRef.current?.abort();
    };
    // We deliberately depend on selectedTask.id AND selectedTask.status only:
    // re-fetching mid-poll when activities arrive would create a refresh loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask?.id, selectedTask?.status, fetchSelectedTask]);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedPrompt = newTask.prompt.trim();
    const trimmedRepoName = newTask.repoName.trim();
    const trimmedRepoUrl = newTask.repoUrl.trim();

    if (!trimmedPrompt) {
      notify.error("Please describe what you want the agent to do.", "Task description required");
      return;
    }
    if (!trimmedRepoName || !trimmedRepoUrl) {
      notify.error("Repository name and URL are both required.", "Repository information missing");
      return;
    }
    try {
      // Validate URL early so the user gets a clean message instead of a Zod issue dump.
      new URL(trimmedRepoUrl);
    } catch {
      notify.error(
        "Repository URL must be a valid URL (e.g. https://github.com/owner/repo).",
        "Invalid repository URL"
      );
      return;
    }

    setCreating(true);
    try {
      const source = {
        repoName: trimmedRepoName,
        repoUrl: trimmedRepoUrl,
        ...(newTask.branch.trim() ? { branch: newTask.branch.trim() } : {}),
      };
      const res = await fetch("/api/v1/agents/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: newTask.providerId,
          prompt: trimmedPrompt,
          source,
          options: {
            autoCreatePr: newTask.autoCreatePr,
          },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.data) {
          upsertTask(data.data);
          setSelectedTask(data.data);
          notify.success(
            `${getAgentInfo(data.data.providerId).name} task created successfully.`,
            "Task started"
          );
        }
        setNewTask({
          providerId: newTask.providerId,
          prompt: "",
          repoName: "",
          repoUrl: "",
          branch: "main",
          autoCreatePr: true,
        });
      } else {
        await showApiError(res, "Failed to start cloud agent task");
      }
    } catch (err) {
      console.error("Failed to create task:", err);
      notify.error(
        err instanceof Error ? err.message : "Network error while creating task",
        "Connection failed"
      );
    } finally {
      setCreating(false);
    }
  };

  const handleSendMessage = async () => {
    if (!selectedTask || !messageInput.trim()) return;
    try {
      const res = await fetch(`/api/v1/agents/tasks/${selectedTask.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "message",
          message: messageInput,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.data) upsertTask(data.data);
        setMessageInput("");
      } else {
        await showApiError(res, "Failed to send message");
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      notify.error(
        err instanceof Error ? err.message : "Network error while sending message",
        "Connection failed"
      );
    }
  };

  const handleApprovePlan = async () => {
    if (!selectedTask) return;
    try {
      const res = await fetch(`/api/v1/agents/tasks/${selectedTask.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.data) upsertTask(data.data);
        notify.success("Plan approved. Agent is now executing.", "Approved");
      } else {
        await showApiError(res, "Failed to approve plan");
      }
    } catch (err) {
      console.error("Failed to approve plan:", err);
      notify.error(
        err instanceof Error ? err.message : "Network error while approving plan",
        "Connection failed"
      );
    }
  };

  const handleCancelTask = async (taskId: string) => {
    try {
      const res = await fetch(`/api/v1/agents/tasks/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.data) upsertTask(data.data);
      } else {
        await showApiError(res, "Failed to cancel task");
      }
    } catch (err) {
      console.error("Failed to cancel task:", err);
      notify.error(
        err instanceof Error ? err.message : "Network error while cancelling task",
        "Connection failed"
      );
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/agents/tasks/${taskId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setTasks((prev) => prev.filter((t) => t.id !== taskId));
        if (selectedTask?.id === taskId) {
          setSelectedTask(null);
        }
        notify.success("Task removed from the list.", "Deleted");
      } else {
        await showApiError(res, "Failed to delete task");
      }
    } catch (err) {
      console.error("Failed to delete task:", err);
      notify.error(
        err instanceof Error ? err.message : "Network error while deleting task",
        "Connection failed"
      );
    } finally {
      setDeleting(false);
      setTaskPendingDelete(null);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { color: string; label: string }> = {
      queued: { color: "bg-zinc-500/10 text-zinc-500", label: t("statusPending") },
      running: { color: "bg-blue-500/10 text-blue-500", label: t("statusRunning") },
      awaiting_approval: {
        color: "bg-amber-500/10 text-amber-600",
        label: t("statusWaitingApproval"),
      },
      completed: { color: "bg-emerald-500/10 text-emerald-600", label: t("statusCompleted") },
      failed: { color: "bg-red-500/10 text-red-500", label: t("statusFailed") },
      cancelled: { color: "bg-zinc-500/10 text-zinc-400", label: t("statusCancelled") },
    };
    const s = statusMap[status] || statusMap.queued;
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${s.color}`}
      >
        {status === "running" && <span className="animate-pulse">●</span>}
        {s.label}
      </span>
    );
  };

  const getAgentInfo = (providerId: string) => {
    return CLOUD_AGENTS.find((a) => a.id === providerId) || CLOUD_AGENTS[0];
  };

  const getPlanText = (task: CloudAgentTask) => {
    return (task.activities || []).find((activity) => activity.type === "plan")?.content || "";
  };

  // Keyboard shortcuts:
  //   Esc           — clear the selected task (when one is selected)
  // Cmd/Ctrl+Enter  — submit the create-task form when focus is anywhere on the page
  //                   (handled at form level, see onKeyDown on the textarea)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedTask && !taskPendingDelete) {
        const target = e.target as HTMLElement | null;
        // Don't hijack Esc when the user is inside an input/textarea/contenteditable
        // (browsers map Esc to "clear/cancel" inside those, and modals own their own Esc)
        if (
          target &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        ) {
          return;
        }
        setSelectedTask(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTask, taskPendingDelete]);

  // Render "live • updated Xs ago" once we have at least one successful poll.
  // Returns null before the first refresh so we don't flash "updated 0s ago"
  // during initial mount.
  const renderLiveIndicator = (timestamp: number | null, active: boolean) => {
    if (!timestamp) return null;
    const secondsAgo = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    const label =
      secondsAgo < 5
        ? "just now"
        : secondsAgo < 60
          ? `${secondsAgo}s ago`
          : `${Math.floor(secondsAgo / 60)}m ago`;
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-text-muted"
        title={`Last refreshed at ${new Date(timestamp).toLocaleTimeString()}`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            active ? "bg-emerald-500 animate-pulse" : "bg-zinc-500/40"
          }`}
          aria-hidden
        />
        {active ? "live" : "paused"} · updated {label}
      </span>
    );
  };

  const formatResult = (result: CloudAgentTask["result"]) => {
    if (!result) return "";
    if (typeof result === "string") return result;
    return JSON.stringify(result, null, 2);
  };

  // Pull a PR URL out of the result blob when present. Different agents shape
  // the result differently; we accept the two common keys.
  const extractPrUrl = (result: CloudAgentTask["result"]): string | null => {
    if (!result || typeof result !== "object") return null;
    const r = result as Record<string, unknown>;
    const candidate =
      typeof r.prUrl === "string"
        ? r.prUrl
        : typeof r.pullRequestUrl === "string"
          ? r.pullRequestUrl
          : null;
    if (!candidate) return null;
    try {
      // Reject anything that isn't a real URL — protects against XSS via href
      const parsed = new URL(candidate);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? candidate : null;
    } catch {
      return null;
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
        <p className="text-sm text-text-muted">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-text-muted mt-1">{t("description")}</p>
        </div>
      </div>

      <Card className="border-purple-500/20 bg-purple-500/5">
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-text-main">{t("aboutTitle")}</h2>
              <p className="text-sm text-text-muted mt-1">{t("aboutDescription")}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {CLOUD_AGENTS.map((agent) => (
              <div
                key={agent.id}
                className="rounded-lg border border-purple-500/15 bg-purple-500/5 p-3"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg">{agent.icon}</span>
                  <p className="text-sm font-medium text-text-main">{agent.name}</p>
                </div>
                <p className="text-xs text-text-muted">{agent.description}</p>
                <p className="text-[10px] text-purple-500 mt-1">{agent.provider}</p>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-purple-500/15 bg-surface/40 p-3 text-sm text-text-muted">
            <span className="font-medium text-text-main">{t("howItWorksTitle")}</span>
            <span className="ml-1">{t("howItWorksDesc")}</span>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500">
            <span className="material-symbols-outlined text-[20px]">add_task</span>
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("newTaskTitle")}</h3>
            <p className="text-sm text-text-muted">{t("newTaskDescription")}</p>
          </div>
        </div>
        <form onSubmit={handleCreateTask} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-text-muted mb-1.5 block">
                {t("selectAgent")}
              </label>
              <select
                value={newTask.providerId}
                onChange={(e) => setNewTask({ ...newTask, providerId: e.target.value })}
                className="w-full rounded-lg border border-border/50 bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {CLOUD_AGENTS.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.provider})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-text-muted mb-1.5 block">
              {t("taskDescription")}
            </label>
            <textarea
              placeholder={t("taskDescriptionPlaceholder")}
              value={newTask.prompt}
              onChange={(e) => setNewTask({ ...newTask, prompt: e.target.value })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !creating) {
                  e.preventDefault();
                  (e.currentTarget.form?.requestSubmit() as unknown) ?? undefined;
                }
              }}
              className="min-h-24 w-full rounded-lg border border-border/50 bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              required
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Repository name"
              placeholder="omniroute"
              value={newTask.repoName}
              onChange={(e) => setNewTask({ ...newTask, repoName: e.target.value })}
              required
            />
            <Input
              label="Repository URL"
              placeholder="https://github.com/owner/repo"
              value={newTask.repoUrl}
              onChange={(e) => setNewTask({ ...newTask, repoUrl: e.target.value })}
              required
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Branch"
              placeholder="main"
              value={newTask.branch}
              onChange={(e) => setNewTask({ ...newTask, branch: e.target.value })}
            />
            <label className="flex items-center gap-2 text-sm text-text-muted pt-7">
              <input
                type="checkbox"
                checked={newTask.autoCreatePr}
                onChange={(e) => setNewTask({ ...newTask, autoCreatePr: e.target.checked })}
                className="h-4 w-4 rounded border-border/60"
              />
              Auto-create PR
            </label>
          </div>
          <div className="flex items-center justify-end gap-3">
            <span className="text-[11px] text-text-muted hidden sm:inline-flex items-center gap-1">
              Tip: press <Kbd>⌘</Kbd> + <Kbd>Enter</Kbd> in the description to submit
            </span>
            <Button type="submit" variant="primary" loading={creating}>
              <span className="material-symbols-outlined text-[16px] mr-1">rocket_launch</span>
              {t("startTask")}
            </Button>
          </div>
        </form>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t("tasks")}</h2>
            {renderLiveIndicator(lastListRefresh, true)}
          </div>
          {tasks.length === 0 ? (
            <EmptyState
              icon="📝"
              title={t("noTasks")}
              description="Start your first task using the form above."
            />
          ) : (
            tasks.map((task) => {
              const agent = getAgentInfo(task.providerId);
              return (
                <Card
                  key={task.id}
                  className={`cursor-pointer transition-all hover:border-primary/30 ${
                    selectedTask?.id === task.id ? "border-primary ring-1 ring-primary/20" : ""
                  }`}
                  onClick={() => setSelectedTask(task)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-lg shrink-0" aria-hidden>
                        {agent.icon}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-main line-clamp-1">
                          {task.prompt || t("untitledTask")}
                        </p>
                        <p className="text-xs text-text-muted">
                          {agent.name} <span aria-hidden>·</span>{" "}
                          <RelativeTime value={task.createdAt} />
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0">{getStatusBadge(task.status)}</div>
                  </div>
                </Card>
              );
            })
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t("taskDetail")}</h2>
            {selectedTask &&
              renderLiveIndicator(
                lastDetailRefresh,
                !TERMINAL_STATUSES.includes(selectedTask.status)
              )}
          </div>
          {selectedTask ? (
            <Card className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-lg shrink-0" aria-hidden>
                    {getAgentInfo(selectedTask.providerId).icon}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium">{getAgentInfo(selectedTask.providerId).name}</p>
                    <p className="text-xs text-text-muted">
                      {t("created")} <RelativeTime value={selectedTask.createdAt} />
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {getStatusBadge(selectedTask.status)}
                  <CopyButton value={selectedTask.id} size="sm" label="Copy task ID" />
                </div>
              </div>

              {selectedTask.status === "awaiting_approval" && getPlanText(selectedTask) && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="material-symbols-outlined text-[16px] text-amber-600">
                      description
                    </span>
                    <span className="text-sm font-medium text-amber-700 dark:text-amber-400">
                      {t("planReady")}
                    </span>
                  </div>
                  <pre className="text-xs text-text-muted whitespace-pre-wrap bg-black/5 dark:bg-white/5 rounded p-2 max-h-32 overflow-auto">
                    {getPlanText(selectedTask)}
                  </pre>
                  <div className="flex gap-2 mt-2">
                    <Button variant="primary" size="sm" onClick={handleApprovePlan}>
                      <span className="material-symbols-outlined text-[14px] mr-1">check</span>
                      {t("approvePlan")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleCancelTask(selectedTask.id)}
                    >
                      {t("rejectPlan")}
                    </Button>
                  </div>
                </div>
              )}

              {selectedTask.activities && selectedTask.activities.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{t("conversation")}</p>
                  <div className="flex flex-col gap-2 max-h-64 overflow-auto">
                    {selectedTask.activities.map((activity) => (
                      <div
                        key={activity.id}
                        className={`p-2 rounded-lg text-xs ${
                          activity.type === "message" || activity.type === "completion"
                            ? "bg-purple-500/10 text-text-main"
                            : "bg-surface/40 text-text-main"
                        }`}
                      >
                        <span className="font-medium capitalize">{activity.type}: </span>
                        {activity.content}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedTask.result &&
                (() => {
                  const prUrl = extractPrUrl(selectedTask.result);
                  return (
                    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="material-symbols-outlined text-[16px] text-emerald-600">
                          check_circle
                        </span>
                        <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                          {t("result")}
                        </span>
                      </div>
                      {prUrl && (
                        <div className="flex items-center gap-2 mb-2 p-2 rounded-md bg-emerald-500/10">
                          <span
                            className="material-symbols-outlined text-[16px] text-emerald-600"
                            aria-hidden
                          >
                            link
                          </span>
                          <a
                            href={prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline truncate flex-1 min-w-0"
                            title={prUrl}
                          >
                            {prUrl}
                          </a>
                          <CopyButton value={prUrl} size="sm" label="Copy PR URL" />
                        </div>
                      )}
                      <pre className="text-xs text-text-muted whitespace-pre-wrap">
                        {formatResult(selectedTask.result)}
                      </pre>
                    </div>
                  );
                })()}

              {selectedTask.error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="material-symbols-outlined text-[16px] text-red-500">
                      error
                    </span>
                    <span className="text-sm font-medium text-red-600">{t("error")}</span>
                  </div>
                  <p className="text-xs text-text-muted">{selectedTask.error}</p>
                </div>
              )}

              {selectedTask.status === "running" && (
                <div className="flex gap-2">
                  <Input
                    placeholder={t("sendMessagePlaceholder")}
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSendMessage()}
                    className="flex-1"
                  />
                  <Button variant="primary" onClick={handleSendMessage}>
                    <span className="material-symbols-outlined text-[16px]">send</span>
                  </Button>
                </div>
              )}

              <div className="flex justify-between pt-3 border-t border-border/30">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCancelTask(selectedTask.id)}
                  disabled={["completed", "failed", "cancelled"].includes(selectedTask.status)}
                >
                  <span className="material-symbols-outlined text-[14px] mr-1">cancel</span>
                  {t("cancel")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTaskPendingDelete(selectedTask)}
                  className="text-red-500 hover:text-red-400"
                >
                  <span className="material-symbols-outlined text-[14px] mr-1">delete</span>
                  {t("delete")}
                </Button>
              </div>
            </Card>
          ) : (
            <EmptyState
              icon="👆"
              title={t("selectTaskPrompt")}
              description="Pick a task from the list to see its plan, activities, and result."
            />
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={taskPendingDelete !== null}
        onClose={() => !deleting && setTaskPendingDelete(null)}
        onConfirm={() => taskPendingDelete && handleDeleteTask(taskPendingDelete.id)}
        title="Delete task?"
        message={
          taskPendingDelete
            ? `This permanently removes "${taskPendingDelete.prompt.slice(0, 80) || "this task"}${
                taskPendingDelete.prompt.length > 80 ? "\u2026" : ""
              }" from the dashboard. The task will not be cancelled upstream\u2014you must do that separately if it's still running.`
            : ""
        }
        confirmText="Delete"
        cancelText="Keep"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
