import { ensureSqliteFlag } from "./sea-guard.js";
import { start } from "./server.js";

// Packaged single-file (SEA) entry. The guard runs before start() touches the
// store — and because @kiln/core now loads node:sqlite lazily (inside
// connect()), importing ./server above does not trigger the driver early.
ensureSqliteFlag(); // may re-exec with --experimental-sqlite and exit
start();
