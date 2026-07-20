// Dev launcher: builds + starts the sidecar, then runs Vite in the
// foreground. Used as Tauri's beforeDevCommand, so `pnpm tauri dev` brings up
// all three processes (sidecar, vite, webview shell).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Model credentials for the sidecar (draft/extract) come from the
// environment. For launchers that don't inherit your shell (the IDE preview
// panel, GUI launches), a gitignored apps/desktop/.env is read here and takes
// precedence. Typical content:  ANTHROPIC_API_KEY=sk-ant-...
function loadDotEnv() {
  const path = join(new URL("..", import.meta.url).pathname, ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const build = spawnSync("pnpm", ["build:sidecar"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const dotEnv = loadDotEnv();
if (Object.keys(dotEnv).length > 0) {
  console.log(`dev.mjs: loaded ${Object.keys(dotEnv).join(", ")} from .env`);
}

const sidecar = spawn("node", ["--experimental-sqlite", "dist-sidecar/main.js"], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, ...dotEnv },
});
sidecar.stdout.on("data", (d) => process.stdout.write(d));

const vite = spawn("pnpm", ["exec", "vite"], { stdio: "inherit" });

const stop = () => {
  sidecar.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
vite.on("exit", (code) => {
  sidecar.kill();
  process.exit(code ?? 0);
});
