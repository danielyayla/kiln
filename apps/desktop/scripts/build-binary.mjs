// Builds the sidecar as a Node single-executable application (SEA): one
// self-contained binary the Tauri bundle ships as an externalBin. Steps follow
// the Node SEA guide (https://nodejs.org/api/single-executable-applications.html):
//   1. bundle the entry to one CJS file (tsup, run separately)
//   2. generate the SEA blob from sea-config.json
//   3. copy the running node binary
//   4. (macOS/Windows) strip the signature so postject can rewrite the binary
//   5. inject the blob with postject
//   6. (macOS) ad-hoc re-sign
//
// Output: dist-binary/<name> (+ a Tauri target-triple-suffixed copy).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

const HERE = new URL("..", import.meta.url).pathname;
const OUT_DIR = join(HERE, "dist-binary");
const BLOB = join(OUT_DIR, "sea-blob.blob");
const BUNDLE = join(OUT_DIR, "binary.cjs");
const NAME = "kiln-sidecar";
const BIN = join(OUT_DIR, NAME);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`\n✗ failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(BUNDLE)) {
  console.error(`✗ ${BUNDLE} missing — run \`pnpm build:binary:bundle\` first.`);
  process.exit(1);
}

// 2. Generate the SEA blob.
run(process.execPath, ["--experimental-sea-config", join(HERE, "sea-config.json")]);

// 3. Copy the node binary as our starting point.
rmSync(BIN, { force: true });
copyFileSync(process.execPath, BIN);

const os = platform();

// 4. Strip the signature (macOS/Windows) so postject can modify the binary.
if (os === "darwin") {
  run("codesign", ["--remove-signature", BIN]);
}

// 5. Inject the blob.
const postjectArgs = [
  "postject",
  BIN,
  "NODE_SEA_BLOB",
  BLOB,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (os === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
run("npx", ["--yes", ...postjectArgs]);

// 6. Ad-hoc re-sign on macOS so the OS will run it.
if (os === "darwin") {
  run("codesign", ["--force", "--sign", "-", BIN]);
}

// A Tauri externalBin is resolved by target-triple suffix; produce that copy too.
// rustc may not be on PATH (rustup installs to ~/.cargo/bin), so fall back to it.
const rustc = ["rustc", join(process.env.HOME ?? "", ".cargo", "bin", "rustc")].find(
  (c) => spawnSync(c, ["-vV"], { encoding: "utf8" }).status === 0,
);
const triple = rustc
  ? spawnSync(rustc, ["-vV"], { encoding: "utf8" })
      .stdout?.split("\n")
      .find((l) => l.startsWith("host: "))
      ?.slice(6)
      .trim()
  : undefined;
if (triple) {
  mkdirSync(join(HERE, "src-tauri", "binaries"), { recursive: true });
  const tauriBin = join(HERE, "src-tauri", "binaries", `${NAME}-${triple}`);
  copyFileSync(BIN, tauriBin);
  if (os === "darwin") run("codesign", ["--force", "--sign", "-", tauriBin]);
  console.log(`\n✓ ${BIN}\n✓ ${tauriBin} (Tauri externalBin)`);
} else {
  console.log(`\n✓ ${BIN}\n(!) could not detect Rust host triple — skipped the Tauri-named copy`);
}
