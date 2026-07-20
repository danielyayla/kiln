import { start } from "./server.js";

// Dev entry: run under `node --experimental-sqlite dist-sidecar/main.js`
// (the flag is supplied by the dev launcher). The packaged binary uses
// binary.ts, which adds the self-reexec flag guard.
start();
