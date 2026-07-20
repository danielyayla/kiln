import { ApiError } from "./client";

// The one place transport/agent failures become copy a person can act on
// (BP-6). Core's domain errors (400/404) already arrive as human sentences —
// pass those through untouched.
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503) {
      // The AI kill switch's copy is already actionable — pass it through.
      if (err.message.includes("disabled in Settings")) return err.message;
      return "No model credentials configured — add your API key in Settings to enable drafting and extraction.";
    }
    if (err.status === 502) {
      return `The model request failed — ${err.message.replace(/^authoring failed: /, "")}`;
    }
    return err.message;
  }
  // fetch() rejects with a TypeError when the sidecar itself is unreachable.
  if (err instanceof TypeError) return "Can't reach the local sidecar — is it running?";
  return err instanceof Error ? err.message : String(err);
}
