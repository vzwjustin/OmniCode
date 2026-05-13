import { cleanupRawOutputFiles, resolveRtkRawOutputTtlMs } from "./engines/rtk/rawOutput.ts";

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

function runCleanup(): void {
  try {
    cleanupRawOutputFiles(resolveRtkRawOutputTtlMs());
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        "[rtk-raw-output] Cleanup failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

export function startRawOutputCleanup(): void {
  if (timer) return;
  runCleanup();
  timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

export function stopRawOutputCleanup(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
