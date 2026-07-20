import { defaultKilnHome, resolveProjectDbPath } from "../projects";

// Canonical on-disk location of the kiln store. Every entry point (CLI, MCP
// server, desktop sidecar) resolves through this helper so they all open the
// same file by default — a relative default like "./kiln.db" would silently
// create a new database per working directory. Since the Projects feature this
// delegates to the full per-process resolution order (KILN_DB_PATH >
// KILN_PROJECT > registry default > legacy ~/.kiln/kiln.db); with no project
// registry present the result is byte-identical to the pre-Projects behavior.
// Ensures the parent directory exists before returning.
export function resolveDbPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = defaultKilnHome(),
): string {
  return resolveProjectDbPath(env, home);
}
