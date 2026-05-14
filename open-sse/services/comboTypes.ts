/**
 * Shared combo types — extracted to break the manifestAdapter ↔ combo cycle.
 *
 * Keep this file dependency-free (no runtime imports from other service modules)
 * so it can be imported safely from any layer.
 */

export type ResolvedComboTarget = {
  kind: "model";
  stepId: string;
  executionKey: string;
  modelStr: string;
  provider: string;
  providerId: string | null;
  connectionId: string | null;
  allowedConnectionIds?: string[] | null;
  weight: number;
  label: string | null;
};
