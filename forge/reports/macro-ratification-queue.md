**5 provisional** across 1 feature(s): **5 clean**, **0 flagged**.

# Ratification queue — distilled decisions (provisional)

## Macro Tracker Survey — 5 decision(s)
- ✓ **[design] Durable Objects hold MCP session state; D1 is the single database** (governs 0 task(s))
   - MCP session state lives in Durable Objects while all persistent data lives in D1 — one database, no secondary store or sync layer.
   - evidence: "Durable Objects hold MCP session state; D1 is the single database"
- ✓ **[design] One module per MCP tool, registered centrally** (governs 0 task(s))
   - Each MCP tool is a small dedicated module (log-food.ts, log-ketone.ts, …) and a single registerTools() in mcp/register-tools.ts wires them all up, so adding a tool never touches routing.
   - evidence: "one small module per tool (log-food.ts, log-ketone.ts, …) registered centrally by registerTools()"
- ✓ **[design] Both surfaces write through one shared data layer** (governs 0 task(s))
   - The MCP tools and the Remix web routes both go through server/keto-log.ts for every D1 read and write, so the web timeline and the tools can never disagree about the data.
   - evidence: "Both the MCP tools and the web routes read and write D1 through it, so the timeline and the tools can never disagree"
- ✓ **[constraint] Every query is scoped by user_id** (governs 0 task(s))
   - All D1 queries carry a user_id predicate resolved from the OAuth context — there is no query path that can cross user boundaries.
   - evidence: "All queries scoped by user_id"
- ✓ **[constraint] Validate at the tool boundary; mandatory units; every write echoes the saved row** (governs 0 task(s))
   - Tool inputs are validated at the boundary, readings must carry their device unit, and every write returns the saved row in structuredContent.entry so the model can confirm without a follow-up read.
   - evidence: "Input validation at the tool boundary; mandatory units on readings; every write echoes the saved row"