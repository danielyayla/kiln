import { resolveDbPath, SqliteStore } from "@kiln/core";
import { AnthropicModelProvider, type ModelProvider } from "@kiln/agents";
import {
  cliEnv,
  runAccept,
  runCreate,
  runDraft,
  runExtract,
  runExport,
  runLink,
  runProjectsCreate,
  runProjectsList,
  runProjectsUse,
  runReview,
  runSetStatus,
  runVerify,
  runShow,
  runSuggestions,
} from "./commands.js";

export * from "./commands.js";

const USAGE = `kiln — authoring CLI (store: KILN_DB_PATH, default ~/.kiln/kiln.db)

  kiln create <type> <title> [--body <text>]     create an entity (${"artifact|requirement|blueprint|work_order"})
              [--work-type <wt>]                 work orders only: ${"feature|bug|refactor|perf|chore"}
  kiln link <fromId> <toId> <linkType>           add a typed edge
  kiln draft <entityId>                          draft a requirement/blueprint from its artifacts (needs model access)
  kiln suggestions <entityId>                    list pending suggestions for an entity
  kiln accept <suggestionId> [--ops 0,2]         apply a suggestion (all ops unless --ops)
  kiln extract <blueprintId> [--accept 0,1 | --accept-all]
                                                 extract candidate work orders (needs model access)
  kiln review <entityId> [--suggest]             flag ambiguity/gaps/conflicts/duplication; --suggest also
                                                 files the proposed fixes as a suggestion (needs model access)
  kiln status <workOrderId> <status> [--force]   set a work order's status (--force overrides the draft→ready completeness gate)
  kiln verify <workOrderId>                      judge a done work order's completion receipts against its
                                                 acceptance criteria; records a verification receipt (needs model access)
  kiln show <entityId>                           print an entity
  kiln export <dir> [--force]                    write the whole graph as markdown files
                                                 (refuses a non-empty dir without --force)
  kiln projects list                             list registered projects (* marks the default)
  kiln projects create <name>                    register a project and seed its product root
  kiln projects use <id|slug|name>               set the default project

Every command accepts --project <id|slug|name> to run against another
registered project for this invocation only. Resolution order:
KILN_DB_PATH > --project/KILN_PROJECT > the registry default project.
`;

function fail(message: string): never {
  console.error(`kiln: ${message}`);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined) fail(`${flag} requires a value`);
  args.splice(i, 2);
  return value;
}

function parseIndexes(raw: string): number[] {
  return raw.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 0) fail(`invalid index "${s.trim()}"`);
    return n;
  });
}

function printEntity(
  prefix: string,
  e: { id: string; type: string; title: string; status: string | null; criticality?: string | null },
): void {
  // Routine criticality stays quiet, mirroring the unset default everywhere else.
  const tags = [e.status, e.criticality !== "routine" ? e.criticality : null].filter(Boolean);
  console.log(`${prefix} ${e.type} ${e.id} — ${e.title}${tags.length > 0 ? ` [${tags.join(", ")}]` : ""}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }

  // Projects subcommands manage the registry itself — no store to open first.
  if (command === "projects") {
    const [sub, ...rest] = args;
    try {
      switch (sub) {
        case "list": {
          const { projects, defaultProject } = runProjectsList();
          if (projects.length === 0) console.log("(no projects registered)");
          for (const p of projects) {
            console.log(`${p.id === defaultProject ? "*" : " "} ${p.slug}  ${p.name}  (${p.id})`);
          }
          break;
        }
        case "create": {
          const [name] = rest;
          if (!name) fail("usage: kiln projects create <name>");
          const entry = runProjectsCreate(name);
          console.log(`created project ${entry.slug} — ${entry.name} (${entry.id})`);
          break;
        }
        case "use": {
          const [ref] = rest;
          if (!ref) fail("usage: kiln projects use <id|slug|name>");
          const entry = runProjectsUse(ref);
          console.log(`default project is now ${entry.slug} — ${entry.name}`);
          break;
        }
        default:
          fail("usage: kiln projects list|create|use");
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // --project pins this invocation to a registered project; it slots into
  // core's resolution order as KILN_PROJECT (KILN_DB_PATH still wins).
  const projectRef = flagValue(args, "--project");
  const store = new SqliteStore(resolveDbPath(cliEnv(process.env, projectRef)));
  // Model access is only constructed for the commands that need it, so
  // create/link/accept/status work without credentials.
  const provider = (): ModelProvider => new AnthropicModelProvider();

  try {
    switch (command) {
      case "create": {
        const body = flagValue(args, "--body") ?? "";
        const workType = flagValue(args, "--work-type");
        const [type, title] = args;
        if (!type || !title) fail("usage: kiln create <type> <title> [--body <text>] [--work-type <type>]");
        printEntity("created", runCreate(store, type, title, body, workType));
        break;
      }
      case "link": {
        const [fromId, toId, type] = args;
        if (!fromId || !toId || !type) fail("usage: kiln link <fromId> <toId> <linkType>");
        runLink(store, fromId, toId, type);
        console.log(`linked ${fromId} --${type}--> ${toId}`);
        break;
      }
      case "draft": {
        const [entityId] = args;
        if (!entityId) fail("usage: kiln draft <entityId>");
        const suggestion = await runDraft(store, provider(), entityId);
        console.log(`suggestion ${suggestion.id} (${suggestion.ops.length} ops) on ${suggestion.targetId}`);
        suggestion.ops.forEach((op, i) =>
          console.log(`  [${i}] ${op.kind} @ ${JSON.stringify(op.anchor.slice(0, 60))}`),
        );
        console.log(`accept with: kiln accept ${suggestion.id} [--ops 0,1,…]`);
        break;
      }
      case "suggestions": {
        const [entityId] = args;
        if (!entityId) fail("usage: kiln suggestions <entityId>");
        const list = runSuggestions(store, entityId);
        if (list.length === 0) console.log("(no suggestions)");
        for (const s of list) {
          console.log(`${s.id} — ${s.source}, ${s.ops.length} ops`);
          s.ops.forEach((op, i) => console.log(`  [${i}] ${op.kind} @ ${JSON.stringify(op.anchor.slice(0, 60))}`));
        }
        break;
      }
      case "accept": {
        const ops = flagValue(args, "--ops");
        const [suggestionId] = args;
        if (!suggestionId) fail("usage: kiln accept <suggestionId> [--ops 0,2]");
        const { entity, revision, appliedOps } = runAccept(
          store,
          suggestionId,
          ops === undefined ? undefined : parseIndexes(ops),
        );
        console.log(`applied ops [${appliedOps.join(",")}] to ${entity.id}; revision ${revision.id}`);
        break;
      }
      case "extract": {
        const acceptRaw = flagValue(args, "--accept");
        const acceptAll = args.includes("--accept-all") && (args.splice(args.indexOf("--accept-all"), 1), true);
        const [blueprintId] = args;
        if (!blueprintId) fail("usage: kiln extract <blueprintId> [--accept 0,1 | --accept-all]");
        const accept = acceptAll ? ("all" as const) : acceptRaw ? parseIndexes(acceptRaw) : ("none" as const);
        const { candidates, accepted } = await runExtract(store, provider(), blueprintId, accept);
        candidates.forEach((c, i) => console.log(`[${i}] ${c.title}`));
        for (const w of accepted) printEntity("accepted →", w);
        if (accepted.length === 0) console.log("(none accepted — re-run with --accept or --accept-all)");
        break;
      }
      case "review": {
        const suggest = args.includes("--suggest") && (args.splice(args.indexOf("--suggest"), 1), true);
        const [entityId] = args;
        if (!entityId) fail("usage: kiln review <entityId> [--suggest]");
        const { findings, suggestion, filed } = await runReview(store, provider(), entityId, suggest);
        if (findings.length === 0) console.log("no findings — the document reads clean");
        for (const f of findings) {
          console.log(`[${f.severity}/${f.kind}] ${f.note}`);
          if (f.quote) console.log(`    > ${f.quote}`);
        }
        if (filed && suggestion) {
          console.log(`\nfiled suggestion ${suggestion.id} (${suggestion.ops.length} ops)`);
          console.log(`accept with: kiln accept ${suggestion.id} [--ops 0,1,…]`);
        } else if (suggestion) {
          console.log(`\n${suggestion.ops.length} fix op(s) proposed — re-run with --suggest to file them`);
        }
        break;
      }
      case "status": {
        const force = args.includes("--force");
        const [workOrderId, status] = args.filter((a) => a !== "--force");
        if (!workOrderId || !status) fail("usage: kiln status <workOrderId> <status> [--force]");
        printEntity("updated", runSetStatus(store, workOrderId, status, { force }));
        break;
      }
      case "verify": {
        const [workOrderId] = args;
        if (!workOrderId) fail("usage: kiln verify <workOrderId>");
        const receipt = await runVerify(store, provider(), workOrderId);
        console.log(`verification ${receipt.id} on ${receipt.workOrderId} — overall: ${receipt.overall}`);
        for (const cr of receipt.criteria) {
          console.log(`  [${cr.status}] ${cr.criterion}`);
          console.log(`      ${cr.reason}`);
        }
        if (receipt.criteria.length === 0) {
          console.log("  (no acceptance criteria to judge — see the overall verdict)");
        }
        break;
      }
      case "export": {
        const force = args.includes("--force") && (args.splice(args.indexOf("--force"), 1), true);
        const [dir] = args;
        if (!dir) fail("usage: kiln export <dir> [--force]");
        const { dir: target, fileCount, orphanCount } = runExport(store, dir, force);
        console.log(
          `exported ${fileCount} file${fileCount === 1 ? "" : "s"} to ${target}` +
            (orphanCount > 0 ? ` (${orphanCount} unlinked in unfiled/)` : ""),
        );
        break;
      }
      case "show": {
        const [entityId] = args;
        if (!entityId) fail("usage: kiln show <entityId>");
        const e = runShow(store, entityId);
        printEntity("", e);
        if (e.body) console.log(`\n${e.body}`);
        break;
      }
      default:
        fail(`unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
