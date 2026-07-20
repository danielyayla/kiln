import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// Pull the raw token out of an `Authorization: Bearer <token>` header.
export function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

// Constant-time comparison so token checking does not leak length/content via
// timing. Returns false if either side is empty.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length === 0 || bb.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// True only when the request carries the exact expected bearer token. An empty
// expected token is a misconfiguration and always denies.
export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken) return false;
  const provided = extractBearerToken(req);
  return provided !== null && safeEqual(provided, expectedToken);
}
