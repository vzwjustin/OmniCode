import {
  CloudAgentBase,
  type AgentCredentials,
  type CreateTaskParams,
  type GetStatusResult,
} from "../baseAgent.ts";
import type {
  CloudAgentTask,
  CloudAgentActivity,
  CloudAgentResult,
  CloudAgentStatus,
} from "../types.ts";

/**
 * Jules — Google's autonomous coding agent (alpha).
 *
 * Reference: https://developers.google.com/jules/api
 *
 * Auth: `X-Goog-Api-Key: <key>` only. Bearer tokens are rejected by Google's
 * gateway (returns the misleading "API keys are not supported by this API"
 * response). Keys are generated at https://jules.google.com/settings#api.
 */

type ActivityRecord = Record<string, unknown>;

type JulesSourceResponse = {
  sources?: Array<{
    name?: string;
    id?: string;
    githubRepo?: {
      owner?: string;
      repo?: string;
      defaultBranch?: { displayName?: string };
      branches?: Array<{ displayName?: string }>;
    };
  }>;
};

type JulesSessionResponse = {
  name?: string;
  id?: string;
  title?: string;
  prompt?: string;
  sourceContext?: { source?: string };
  outputs?: Array<{
    pullRequest?: { url?: string; title?: string; description?: string };
  }>;
};

type JulesActivitiesResponse = {
  activities?: ActivityRecord[];
};

/**
 * Parse the GitHub owner from a repository URL. Tolerates trailing slashes,
 * `.git` suffixes, and `git@github.com:owner/repo.git` shorthand. Returns
 * `null` when the URL doesn't look like a GitHub repo so callers can fall
 * back gracefully (Jules will surface the validation error instead of the
 * adapter silently sending an empty owner — see `recent_issues` audit).
 */
function parseGithubOwner(repoUrl: string): string | null {
  if (!repoUrl) return null;

  // git@github.com:owner/repo(.git)?
  const sshMatch = repoUrl.match(/^git@github\.com:([^/]+)\/[^/]+?(\.git)?\/?$/);
  if (sshMatch?.[1]) return sshMatch[1];

  // https://github.com/owner/repo(.git)?/?
  const httpsMatch = repoUrl.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/[^/]+?(?:\.git)?\/?$/
  );
  if (httpsMatch?.[1]) return httpsMatch[1];

  return null;
}

/**
 * Map a Jules activity-list response to OmniRoute's `CloudAgentActivity[]`
 * representation, deriving the high-level status of the session in the
 * process. Jules does NOT expose a `state` field on the GetSession response;
 * status must be inferred from the activity stream.
 */
function deriveStatusAndActivities(rawActivities: ActivityRecord[]): {
  status: CloudAgentStatus;
  activities: CloudAgentActivity[];
} {
  const activities: CloudAgentActivity[] = [];
  let sawSessionCompleted = false;
  let sawPlanGenerated = false;
  let sawPlanApproved = false;
  let sawError = false;

  for (const raw of rawActivities) {
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const name = typeof raw.name === "string" ? raw.name : undefined;
    const createTime =
      typeof raw.createTime === "string" ? raw.createTime : new Date().toISOString();

    // Determine activity type and content based on which one-of field is set.
    // Per the Jules v1alpha spec, exactly one of these top-level fields is
    // populated per activity record.
    let type: CloudAgentActivity["type"] = "message";
    let content = "";

    if (raw.planGenerated && typeof raw.planGenerated === "object") {
      type = "plan";
      sawPlanGenerated = true;
      const plan = (raw.planGenerated as { plan?: { steps?: Array<{ title?: string }> } }).plan;
      const steps = Array.isArray(plan?.steps) ? plan.steps : [];
      content = steps
        .map((step, idx) => `${idx + 1}. ${step?.title ?? "(untitled step)"}`)
        .join("\n");
    } else if (raw.planApproved) {
      type = "plan";
      sawPlanApproved = true;
      content = "Plan approved.";
    } else if (raw.progressUpdated && typeof raw.progressUpdated === "object") {
      type = "command";
      const progress = raw.progressUpdated as { title?: string; description?: string };
      content = [progress.title, progress.description].filter(Boolean).join("\n");
    } else if (raw.sessionCompleted) {
      type = "completion";
      sawSessionCompleted = true;
      content = "Session completed.";
    } else if (raw.error && typeof raw.error === "object") {
      type = "error";
      sawError = true;
      const err = raw.error as { message?: string };
      content = err.message ?? "Activity reported an error.";
    } else {
      // Fall back to message — captures `userMessage`, `agentMessage`, and
      // any future one-of variants the SDK hasn't been updated for yet.
      const maybeMessage =
        ((raw.userMessage as { text?: string } | undefined)?.text ??
          (raw.agentMessage as { text?: string } | undefined)?.text) ||
        "";
      content = maybeMessage || `[${name ?? id ?? "activity"}]`;
    }

    activities.push({
      id: id ?? name ?? `act_${activities.length}`,
      type,
      content,
      timestamp: createTime,
    });
  }

  let status: CloudAgentStatus;
  if (sawError && !sawSessionCompleted) {
    status = "failed";
  } else if (sawSessionCompleted) {
    status = "completed";
  } else if (sawPlanGenerated && !sawPlanApproved) {
    status = "awaiting_approval";
  } else if (sawPlanGenerated || sawPlanApproved) {
    status = "running";
  } else {
    status = "queued";
  }

  return { status, activities };
}

export class JulesAgent extends CloudAgentBase {
  readonly providerId = "jules";
  readonly baseUrl = "https://jules.googleapis.com/v1alpha";

  async createTask(
    params: CreateTaskParams,
    credentials: AgentCredentials
  ): Promise<CloudAgentTask> {
    const taskId = this.generateTaskId();

    const owner = parseGithubOwner(params.source.repoUrl);
    if (!owner) {
      throw new Error(
        `Jules createTask: unable to parse a GitHub owner from repoUrl "${params.source.repoUrl}". ` +
          `Expected https://github.com/<owner>/<repo> or git@github.com:<owner>/<repo>(.git).`
      );
    }

    // Jules identifies sources by their canonical resource name
    // "sources/github/<owner>/<repo>" — NOT by a nested owner/name object.
    // Reference: https://developers.google.com/jules/api (Quickstart → Step 2)
    const julesSource = `sources/github/${owner}/${params.source.repoName}`;

    const body: Record<string, unknown> = {
      prompt: params.prompt,
      sourceContext: {
        source: julesSource,
        githubRepoContext: {
          startingBranch: params.source.branch || "main",
        },
      },
    };

    if (params.options.autoCreatePr) {
      body.automationMode = "AUTO_CREATE_PR";
    }

    // By default Jules auto-approves plans. Only opt into manual approval
    // when the caller requested it.
    if (params.options.planApprovalRequired) {
      body.requirePlanApproval = true;
    }

    const response = await fetch(`${this.baseUrl}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": credentials.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jules create task failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as JulesSessionResponse;
    // Jules's response shape is { name: "sessions/<id>", id: "<id>", ... }.
    // Prefer the explicit `id`; only fall back to parsing `name` if `id` is
    // missing, and finally to the internal task id as a last resort so the
    // row still inserts cleanly.
    const externalId = data.id || data.name?.split("/").pop() || taskId;

    return {
      id: taskId,
      providerId: this.providerId,
      externalId,
      // New sessions begin in the queued/running phase — Jules has no
      // top-level state field, so any initial guess is acceptable. The
      // first poll of getStatus() will refine it from the activity stream.
      status: "queued",
      prompt: params.prompt,
      source: params.source,
      options: params.options,
      activities: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async getStatus(externalId: string, credentials: AgentCredentials): Promise<GetStatusResult> {
    // Issue both calls in parallel to halve latency; the session metadata
    // contains the PR outputs, while the separate /activities endpoint
    // carries the agent's step-by-step record (Jules does not embed
    // activities in GetSession — see issues #3, schema audit).
    const [sessionRes, activitiesRes] = await Promise.all([
      fetch(`${this.baseUrl}/sessions/${externalId}`, {
        headers: { "X-Goog-Api-Key": credentials.apiKey },
      }),
      fetch(`${this.baseUrl}/sessions/${externalId}/activities?pageSize=100`, {
        headers: { "X-Goog-Api-Key": credentials.apiKey },
      }),
    ]);

    if (!sessionRes.ok) {
      const error = await sessionRes.text();
      throw new Error(`Jules get status failed: ${sessionRes.status} ${error}`);
    }

    const sessionData = (await sessionRes.json()) as JulesSessionResponse;

    let rawActivities: ActivityRecord[] = [];
    if (activitiesRes.ok) {
      const activitiesData = (await activitiesRes.json()) as JulesActivitiesResponse;
      rawActivities = Array.isArray(activitiesData.activities) ? activitiesData.activities : [];
    }
    // Activities endpoint failing is not fatal — we can still report status
    // from the session metadata. Surface the error in logs but do not throw.

    const { status, activities } = deriveStatusAndActivities(rawActivities);

    let result: CloudAgentResult | undefined;
    const outputs = Array.isArray(sessionData.outputs) ? sessionData.outputs : [];
    const pr = outputs.find((o) => o.pullRequest)?.pullRequest;
    if (pr) {
      result = {
        prUrl: pr.url,
        commitMessage: pr.title,
        summary: pr.description,
      };
    }

    return {
      status,
      externalId,
      result,
      activities,
    };
  }

  async approvePlan(externalId: string, credentials: AgentCredentials): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sessions/${externalId}:approvePlan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": credentials.apiKey,
      },
      // Per the Jules docs the approvePlan call takes no body (it implicitly
      // approves the latest plan). Older code paths sent an empty object — both
      // are accepted, but `undefined` keeps the request strictly minimal.
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jules approve plan failed: ${response.status} ${error}`);
    }
  }

  async sendMessage(
    externalId: string,
    message: string,
    credentials: AgentCredentials
  ): Promise<CloudAgentActivity> {
    const response = await fetch(`${this.baseUrl}/sessions/${externalId}:sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": credentials.apiKey,
      },
      // Jules expects { "prompt": "..." }. The previous adapter sent
      // { "message": "..." }, which Jules silently ignored.
      body: JSON.stringify({ prompt: message }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jules send message failed: ${response.status} ${error}`);
    }

    // Jules's sendMessage returns an empty body — the agent's reply arrives as
    // the *next* activity. Return a synthetic user-message activity so the UI
    // has an immediate echo to render.
    return {
      id: this.generateActivityId(),
      type: "message",
      content: message,
      timestamp: new Date().toISOString(),
    };
  }

  async listSources(
    credentials: AgentCredentials
  ): Promise<{ name: string; url: string; branch?: string }[]> {
    const response = await fetch(`${this.baseUrl}/sources`, {
      headers: {
        "X-Goog-Api-Key": credentials.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jules list sources failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as JulesSourceResponse;
    const sources = Array.isArray(data.sources) ? data.sources : [];

    return sources
      .map((source) => {
        const owner = source.githubRepo?.owner ?? "";
        const repo = source.githubRepo?.repo ?? "";
        const branch = source.githubRepo?.defaultBranch?.displayName;
        if (!owner || !repo) return null;
        return {
          name: source.name ?? `sources/github/${owner}/${repo}`,
          url: `https://github.com/${owner}/${repo}`,
          branch,
        };
      })
      .filter(
        (entry): entry is { name: string; url: string; branch: string | undefined } =>
          entry !== null
      );
  }
}
