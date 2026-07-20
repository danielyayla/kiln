import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// A single-executable-application (SEA) binary is the Node binary itself, so it
// ignores CLI flags like --experimental-sqlite (there's no script argv to parse
// them against). On Node 22.x node:sqlite still needs that flag; on Node 24+ it
// is stable and this guard is a no-op.
//
// The trick: NODE_OPTIONS *is* honored by a SEA binary. If node:sqlite can't
// load, re-exec ourselves once with the flag injected via NODE_OPTIONS. This
// keeps the binary self-contained — no launcher flag or wrapper script needed.
export function ensureSqliteFlag(): void {
  if (process.env.KILN_SEA_REEXEC === "1") return; // already in the re-execed child

  const require = createRequire(process.execPath);
  try {
    require("node:sqlite");
    return; // flag present, or Node 24+ where it's stable
  } catch {
    const result = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: {
        ...process.env,
        KILN_SEA_REEXEC: "1",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-sqlite`.trim(),
      },
    });
    process.exit(result.status ?? 0);
  }
}
