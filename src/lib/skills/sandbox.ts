import { createRequire } from "module";
import type { ChildProcess } from "child_process";
import { randomUUID } from "crypto";

const require = createRequire(import.meta.url);
const childProcess = require("child_process") as typeof import("child_process");

interface SandboxConfig {
  cpuLimit: number;
  memoryLimit: number;
  timeout: number;
  networkEnabled: boolean;
  readOnly: boolean;
  /**
   * Maximum bytes captured from child stdout/stderr each. Anything beyond is
   * dropped and the sandbox is killed. Prevents a hostile or buggy custom
   * skill from OOM'ing the parent process by spamming output.
   */
  maxOutputBytes: number;
  /**
   * Milliseconds to wait after SIGTERM before sending SIGKILL. Skills that
   * trap SIGTERM (or that exec into shells which do) must not be able to
   * outlive the configured timeout.
   */
  killGraceMs: number;
}

interface SandboxResult {
  id: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
  killed: boolean;
  /** True when the sandbox was killed for exceeding maxOutputBytes. */
  outputTruncated: boolean;
}

const DEFAULT_CONFIG: SandboxConfig = {
  cpuLimit: 100,
  memoryLimit: 256,
  timeout: 30000,
  networkEnabled: false,
  readOnly: true,
  maxOutputBytes: 1 * 1024 * 1024, // 1 MiB each for stdout and stderr
  killGraceMs: 2000,
};

class SandboxRunner {
  private static instance: SandboxRunner;
  private runningContainers: Map<string, ChildProcess> = new Map();
  private config: SandboxConfig;

  private constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(config?: Partial<SandboxConfig>): SandboxRunner {
    if (!SandboxRunner.instance) {
      SandboxRunner.instance = new SandboxRunner(config);
    }
    return SandboxRunner.instance;
  }

  setConfig(config: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async run(
    image: string,
    command: string[],
    env: Record<string, string> = {},
    configOverride: Partial<SandboxConfig> = {}
  ): Promise<SandboxResult> {
    const sandboxId = randomUUID();
    const startTime = Date.now();
    const config = { ...this.config, ...configOverride };

    const dockerArgs = [
      "run",
      "--rm",
      "--name",
      `omniroute-sandbox-${sandboxId}`,
      "--cpus",
      `${config.cpuLimit / 1000}`,
      "--memory",
      `${config.memoryLimit}m`,
      "--network",
      config.networkEnabled ? "bridge" : "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "100",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs",
      "/workspace:rw,noexec,nosuid,size=64m",
      "--workdir",
      "/workspace",
    ];

    if (config.readOnly) {
      dockerArgs.push("--read-only");
    }

    dockerArgs.push(image, ...command);

    return new Promise((resolve) => {
      const proc = childProcess.spawn("docker", dockerArgs, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.runningContainers.set(sandboxId, proc);

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputTruncated = false;

      const captureStdout = (data: Buffer) => {
        if (outputTruncated) return;
        const remaining = config.maxOutputBytes - stdoutBytes;
        if (remaining <= 0) {
          outputTruncated = true;
          this.killEscalating(sandboxId, config.killGraceMs);
          return;
        }
        const slice = data.length > remaining ? data.subarray(0, remaining) : data;
        stdout += slice.toString();
        stdoutBytes += slice.length;
        if (data.length > remaining) {
          outputTruncated = true;
          this.killEscalating(sandboxId, config.killGraceMs);
        }
      };

      const captureStderr = (data: Buffer) => {
        if (outputTruncated) return;
        const remaining = config.maxOutputBytes - stderrBytes;
        if (remaining <= 0) {
          outputTruncated = true;
          this.killEscalating(sandboxId, config.killGraceMs);
          return;
        }
        const slice = data.length > remaining ? data.subarray(0, remaining) : data;
        stderr += slice.toString();
        stderrBytes += slice.length;
        if (data.length > remaining) {
          outputTruncated = true;
          this.killEscalating(sandboxId, config.killGraceMs);
        }
      };

      proc.stdout?.on("data", captureStdout);
      proc.stderr?.on("data", captureStderr);

      const timeoutId = setTimeout(() => {
        this.killEscalating(sandboxId, config.killGraceMs);
      }, config.timeout);

      proc.on("close", (code) => {
        clearTimeout(timeoutId);
        this.runningContainers.delete(sandboxId);

        resolve({
          id: sandboxId,
          exitCode: code,
          stdout,
          stderr,
          duration: Date.now() - startTime,
          killed: code === null,
          outputTruncated,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        this.runningContainers.delete(sandboxId);

        resolve({
          id: sandboxId,
          exitCode: -1,
          stdout,
          stderr: err.message,
          duration: Date.now() - startTime,
          killed: false,
          outputTruncated,
        });
      });
    });
  }

  /**
   * SIGTERM -> wait grace period -> SIGKILL escalation. A skill that traps
   * SIGTERM must not be able to outlive the timeout or output cap.
   */
  private killEscalating(sandboxId: string, graceMs: number): void {
    const proc = this.runningContainers.get(sandboxId);
    if (!proc) return;

    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    childProcess.spawn("docker", ["kill", "--signal=SIGTERM", `omniroute-sandbox-${sandboxId}`], {
      stdio: "ignore",
    });

    const killTimer = setTimeout(() => {
      const stillRunning = this.runningContainers.get(sandboxId);
      if (stillRunning) {
        try {
          stillRunning.kill("SIGKILL");
        } catch {
          // ignore
        }
        childProcess.spawn(
          "docker",
          ["kill", "--signal=SIGKILL", `omniroute-sandbox-${sandboxId}`],
          { stdio: "ignore" }
        );
        this.runningContainers.delete(sandboxId);
      }
    }, graceMs);
    killTimer.unref?.();
  }

  kill(sandboxId: string): boolean {
    const proc = this.runningContainers.get(sandboxId);
    if (proc) {
      this.killEscalating(sandboxId, this.config.killGraceMs);
      return true;
    }
    return false;
  }

  killAll(): void {
    for (const id of Array.from(this.runningContainers.keys())) {
      this.killEscalating(id, this.config.killGraceMs);
    }
    this.runningContainers.clear();
  }

  isRunning(sandboxId: string): boolean {
    return this.runningContainers.has(sandboxId);
  }

  getRunningCount(): number {
    return this.runningContainers.size;
  }
}

export const sandboxRunner = SandboxRunner.getInstance();
export type { SandboxConfig, SandboxResult };
