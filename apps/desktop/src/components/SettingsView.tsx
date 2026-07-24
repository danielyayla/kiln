import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthoringSkillDoc, UsageBucket, UsageReport } from "@kiln/core";
import { api, type AgentAccessStatus } from "../lib/client";
import { friendlyError } from "../lib/errors";
import {
  claudeMcpAddCommand,
  jsonConfigSnippet,
  rePinPrompt,
  showConnection,
  statusLine,
} from "../lib/agent-access";
import { declaredTemplateTypes, type TemplateType } from "../lib/skill-templates";
import { Button, Input, RowMenu, SectionHeader, useToast } from "./ui";

// Template-override chip: reuses the entity badge palette (ui/Badge is
// EntityType-keyed, and these chips point at the same document types).
const TEMPLATE_BADGE: Record<TemplateType, { fg: string; bg: string }> = {
  requirement: { fg: "var(--k-req-fg)", bg: "var(--k-req-bg)" },
  blueprint: { fg: "var(--k-bp-fg)", bg: "var(--k-bp-bg)" },
  "work-order": { fg: "var(--k-wo-fg)", bg: "var(--k-wo-bg)" },
};

function TemplateChip({ type }: { type: TemplateType }) {
  return (
    <span
      title={`Overrides the built-in ${type} template (first enabled skill declaring a type wins)`}
      style={{
        fontSize: font.xs,
        color: TEMPLATE_BADGE[type].fg,
        background: TEMPLATE_BADGE[type].bg,
        borderRadius: radius.sm,
        padding: "1px 5px",
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}
    >
      Template: {type}
    </span>
  );
}
import { color, font, radius, space } from "../theme";

// Settings (AI settings & usage): the user's own AI configuration — key,
// provider, and the kill switch. Renders navigator-less like Pulse. The raw
// key exists here only inside the input while typing; everything rendered
// afterwards comes from the sidecar's masked view.

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.lg,
        padding: space(5),
        display: "flex",
        flexDirection: "column",
        gap: space(4),
      }}
    >
      <SectionHeader style={{ margin: 0 }}>{title}</SectionHeader>
      {children}
    </section>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space(4) }}>
      <span style={{ width: 120, flexShrink: 0, fontSize: font.sm, color: color.muted }}>{label}</span>
      {children}
    </div>
  );
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

// Costs are estimates from a static pricing table — render them as such.
// null = tokens present but the model has no published pricing.
function fmtUsd(v: number | null): string {
  if (v === null) return "—";
  return `≈ $${v >= 0.01 || v === 0 ? v.toFixed(2) : v.toFixed(4)}`;
}

// One quiet stat: value over caption, text tokens only.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: "1 1 120px", minWidth: 120 }}>
      <div style={{ fontSize: font.lg, fontWeight: 600, color: color.text }}>{value}</div>
      <div style={{ fontSize: font.xs, color: color.muted }}>{label}</div>
    </div>
  );
}

// The token series as thin baseline-anchored bars — single fill (the X-ray's
// --k-ins-bg convention), 2px gaps, per-bar tooltip; the breakdown tables
// below are the accessible table view of the same report.
function UsageBars({ buckets }: { buckets: UsageBucket[] }) {
  const max = Math.max(...buckets.map((b) => b.totalTokens), 1);
  return (
    <div>
      <div
        data-testid="usage-series"
        style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 72 }}
      >
        {buckets.map((b) => (
          <div
            key={b.key}
            title={`${b.key} — ${fmtTokens(b.totalTokens)} tokens${b.totalTokens > 0 ? ` · ${fmtUsd(b.estimatedCostUsd)}` : ""}`}
            style={{
              flex: "1 1 0",
              minWidth: 2,
              height: b.totalTokens === 0 ? 2 : Math.max(4, Math.round((b.totalTokens / max) * 72)),
              background: b.totalTokens === 0 ? color.border : "var(--k-ins-bg)",
              borderTop: b.totalTokens === 0 ? "none" : `2px solid ${color.ins}`,
              borderRadius: `${radius.sm}px ${radius.sm}px 0 0`,
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: font.xs,
          color: color.faint,
          marginTop: space(1),
        }}
      >
        <span>{buckets[0]?.key}</span>
        <span>{buckets[buckets.length - 1]?.key}</span>
      </div>
    </div>
  );
}

// A small name/tokens/cost table; numbers right-aligned, text tokens only.
function BreakdownTable({
  title,
  testid,
  rows,
}: {
  title: string;
  testid: string;
  rows: { name: string; tokens: number; cost: number | null }[];
}) {
  return (
    <div data-testid={testid} style={{ flex: "1 1 220px", minWidth: 0 }}>
      <SectionHeader size="sm" style={{ marginTop: 0, marginBottom: space(2) }}>
        {title}
      </SectionHeader>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: font.sm }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} style={{ borderTop: `1px solid ${color.border}` }}>
              <td style={{ padding: `${space(1.5)}px 0`, color: color.text }}>{r.name}</td>
              <td style={{ padding: `${space(1.5)}px 0`, textAlign: "right", color: color.muted }}>
                {fmtTokens(r.tokens)}
              </td>
              <td style={{ padding: `${space(1.5)}px 0 ${space(1.5)}px ${space(3)}px`, textAlign: "right", color: color.muted }}>
                {fmtUsd(r.cost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Starter body for a new authoring skill: explains what the document is for
// and the optional per-type template convention, so the editor opens on
// something self-explanatory rather than a blank page.
const NEW_SKILL_BODY = `Describe your authoring standards here — structure, section order, tone, naming conventions, terminology, required sections. Active skills are injected into every AI drafting, extraction, chat, and review call.

Optionally declare a template that replaces the built-in structure when the AI drafts a given document type. Put the template in a code fence under a "## Template: requirement", "## Template: blueprint", or "## Template: work-order" heading:

## Template: blueprint

\`\`\`
## <your first section>
<what belongs in it>

## <your second section>
<what belongs in it>
\`\`\`
`;

// Authoring skills: skills are SETTINGS documents — this card is their entire
// world. Create, view, edit, rename, enable/disable, reorder, and delete all
// happen here; nothing else in the app renders skill text (2026-07-13
// reversal: configuration, not knowledge).
function AuthoringSkillsCard() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [newTitle, setNewTitle] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");

  const skills = useQuery({ queryKey: ["authoring-skills"], queryFn: api.authoringSkills });

  const put = useMutation({
    mutationFn: api.putAuthoringSkills,
    // The PUT response is the persisted (deduped) array — trust it directly.
    onSuccess: (docs) => queryClient.setQueryData(["authoring-skills"], docs),
    onError: (e) => toast(friendlyError(e)),
  });

  const docs = skills.data ?? [];

  const closeEditor = () => setEditingId(null);

  // Guard against silently discarding edits: closing (or switching away from)
  // an editor with unsaved title/body changes asks first.
  const confirmDiscard = () => {
    const editing = docs.find((d) => d.id === editingId);
    const dirty = editing && (draftTitle !== editing.title || draftBody !== editing.body);
    return !dirty || window.confirm("Discard unsaved changes to this skill?");
  };

  const openEditor = (doc: AuthoringSkillDoc) => {
    if (editingId && editingId !== doc.id && !confirmDiscard()) return;
    setEditingId(doc.id);
    setDraftTitle(doc.title);
    setDraftBody(doc.body);
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = [...docs];
    const [doc] = next.splice(index, 1);
    next.splice(index + delta, 0, doc);
    put.mutate(next);
  };

  const createSkill = (title: string) => {
    const doc: AuthoringSkillDoc = {
      id: crypto.randomUUID(),
      title,
      body: NEW_SKILL_BODY,
      enabled: true,
    };
    put.mutate([...docs, doc], { onSuccess: () => openEditor(doc) });
    setNewTitle("");
  };

  return (
    <Card title="Authoring skills">
      <p style={{ margin: 0, fontSize: font.sm, color: color.muted }}>
        Authoring skills define how the AI writes and edits requirements, blueprints, and work orders —
        structure, style, terminology, and your own conventions. Enabled skills apply to every draft,
        extraction, chat, and review; order is injection order. Skills live here in Settings only.
      </p>

      {skills.isPending ? (
        <p style={{ margin: 0, fontSize: font.sm, color: color.muted }}>Loading skills…</p>
      ) : docs.length === 0 ? (
        <p data-testid="skills-empty" style={{ margin: 0, fontSize: font.sm, color: color.muted }}>
          No skills yet — the built-in house methodology applies.
        </p>
      ) : (
        <ul data-testid="skills-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {docs.map((doc, i) => (
            <li
              key={doc.id}
              style={{
                borderTop: i === 0 ? "none" : `1px solid ${color.border}`,
                padding: `${space(1.5)}px 0`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: space(2) }}>
                {/* 1-based position = injection order */}
                <span style={{ fontSize: font.xs, color: color.muted, width: space(4), textAlign: "right", flexShrink: 0 }}>
                  {i + 1}
                </span>
                <input
                  type="checkbox"
                  aria-label={`${doc.title} enabled`}
                  checked={doc.enabled}
                  disabled={put.isPending}
                  onChange={(e) =>
                    put.mutate(docs.map((d) => (d.id === doc.id ? { ...d, enabled: e.target.checked } : d)))
                  }
                  style={{ accentColor: color.accent, flexShrink: 0 }}
                />
                <button
                  onClick={() => {
                    if (editingId === doc.id) {
                      if (confirmDiscard()) closeEditor();
                    } else {
                      openEditor(doc);
                    }
                  }}
                  title={editingId === doc.id ? "Close editor" : "Edit this skill"}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: "left",
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    fontSize: font.sm,
                    color: doc.enabled ? color.text : color.muted,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {doc.title}
                </button>
                {declaredTemplateTypes(doc.body).map((t) => (
                  <TemplateChip key={t} type={t} />
                ))}
                {docs.length > 1 && (
                  <>
                    <Button variant="ghost" aria-label={`Move ${doc.title} up`} disabled={i === 0 || put.isPending} onClick={() => move(i, -1)}>
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Move ${doc.title} down`}
                      disabled={i === docs.length - 1 || put.isPending}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </Button>
                  </>
                )}
                <RowMenu
                  label={`Actions for ${doc.title}`}
                  items={[
                    {
                      label: "Delete",
                      danger: true,
                      onSelect: () => {
                        if (window.confirm(`Delete the skill "${doc.title}"? There is no undo.`)) {
                          if (editingId === doc.id) closeEditor();
                          put.mutate(docs.filter((d) => d.id !== doc.id));
                        }
                      },
                    },
                  ]}
                />
              </div>

              {editingId === doc.id && (
                <div
                  data-testid="skill-editor"
                  style={{ display: "flex", flexDirection: "column", gap: space(2), marginTop: space(2) }}
                >
                  <Input
                    aria-label="Skill title"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                  />
                  <textarea
                    aria-label="Skill body"
                    value={draftBody}
                    onChange={(e) => setDraftBody(e.target.value)}
                    rows={14}
                    spellCheck={false}
                    style={{
                      width: "100%",
                      resize: "vertical",
                      fontFamily: "ui-monospace, monospace",
                      fontSize: font.sm,
                      lineHeight: 1.5,
                      color: color.text,
                      background: color.bg,
                      border: `1px solid ${color.border}`,
                      borderRadius: radius.md,
                      padding: space(3),
                      boxSizing: "border-box",
                    }}
                  />
                  <div style={{ display: "flex", gap: space(2), justifyContent: "flex-end" }}>
                    <Button variant="ghost" onClick={() => confirmDiscard() && closeEditor()}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!draftTitle.trim() || put.isPending}
                      onClick={() =>
                        put.mutate(
                          docs.map((d) =>
                            d.id === doc.id ? { ...d, title: draftTitle.trim(), body: draftBody } : d,
                          ),
                          { onSuccess: closeEditor },
                        )
                      }
                    >
                      Save
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        style={{ display: "flex", gap: space(2), alignItems: "center" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (newTitle.trim()) createSkill(newTitle.trim());
        }}
      >
        <Input
          aria-label="New skill title"
          placeholder="e.g. Blueprint structure & tone"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button variant="primary" type="submit" disabled={!newTitle.trim() || put.isPending}>
          New skill
        </Button>
      </form>
    </Card>
  );
}

// The AI toggle's switch markup, factored out for the agent-access toggle.
// The checkbox stays the real control (testid + role="switch"); the track/thumb
// span is purely its visual.
function Switch({
  checked,
  disabled,
  onChange,
  testid,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testid?: string;
  ariaLabel: string;
}) {
  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <input
        data-testid={testid}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ position: "absolute", inset: 0, opacity: 0, margin: 0, cursor: "pointer" }}
      />
      <span
        aria-hidden
        style={{
          width: 34,
          height: 20,
          borderRadius: 10,
          background: checked ? color.accent : color.border,
          transition: "background 120ms",
          display: "inline-block",
        }}
      >
        <span
          style={{
            display: "block",
            width: 16,
            height: 16,
            borderRadius: 8,
            background: color.bg,
            margin: 2,
            transform: checked ? "translateX(14px)" : "none",
            transition: "transform 120ms",
          }}
        />
      </span>
    </span>
  );
}

// Copy-to-clipboard with the app's flash convention (ContextInspector's Copy
// context): swap the label to "Copied ✓" for 1.5s. Quiet on failure — a denied
// clipboard permission simply doesn't flash.
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {})
      }
    >
      {copied ? "Copied ✓" : label}
    </Button>
  );
}

// One labelled, horizontally-scrollable code block with its own copy button.
function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: font.xs, color: color.muted }}>{label}</span>
        <CopyButton text={text} label="Copy" />
      </div>
      <pre
        style={{
          margin: 0,
          overflowX: "auto",
          background: color.bg,
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          padding: space(3),
          fontFamily: "ui-monospace, monospace",
          fontSize: font.xs,
          lineHeight: 1.5,
          color: color.text,
          whiteSpace: "pre",
        }}
      >
        {text}
      </pre>
    </div>
  );
}

const STATUS_TONE: Record<"running" | "stopped" | "error", string> = {
  running: color.ok,
  stopped: color.faint,
  error: color.danger,
};

// Agent access (bundled MCP server feature): the whole section is a pure
// function of GET /agent-access — no webview-side inference about listener
// state. Toggling, port edits, regenerate, and re-pin each round-trip through
// the API and re-render from the returned status.
function AgentAccessCard() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [confirmingRegen, setConfirmingRegen] = useState(false);

  const status = useQuery({ queryKey: ["agent-access"], queryFn: api.agentAccess });
  // The active-project context the switcher already loads — used only to detect
  // active ≠ pinned; never to re-pin automatically.
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });

  // Every route returns the fresh status; trust it directly (like the skills PUT).
  const onStatus = (s: AgentAccessStatus) => queryClient.setQueryData(["agent-access"], s);

  const put = useMutation({ mutationFn: api.putAgentAccess, onSuccess: onStatus, onError: (e) => toast(friendlyError(e)) });
  const regen = useMutation({
    mutationFn: api.regenerateAgentToken,
    onSuccess: (s) => {
      onStatus(s);
      toast("Token regenerated — reconnect your agent with the new snippet");
    },
    onError: (e) => toast(friendlyError(e)),
  });
  const pin = useMutation({
    mutationFn: api.pinAgentProject,
    onSuccess: (s) => {
      onStatus(s);
      toast(`Agent access now serves “${s.project?.name ?? "…"}”`);
    },
    onError: (e) => toast(friendlyError(e)),
  });

  if (status.isPending) {
    return (
      <Card title="Agent access">
        <p style={{ margin: 0, fontSize: font.sm, color: color.muted }}>Loading…</p>
      </Card>
    );
  }
  if (status.isError || !status.data) {
    // The routes 404 when the sidecar build lacks the manager; say so plainly
    // rather than rendering a dead toggle.
    return (
      <Card title="Agent access">
        <p style={{ margin: 0, fontSize: font.sm, color: color.muted }}>
          Agent access unavailable — {friendlyError(status.error ?? new TypeError("unreachable"))}
        </p>
      </Card>
    );
  }
  const s = status.data;
  const line = statusLine(s);
  const repin = rePinPrompt(s, projects.data);
  const busy = put.isPending || regen.isPending || pin.isPending;

  const submitPort = () => {
    if (portDraft === null) return;
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast("Port must be a whole number between 1 and 65535");
      return;
    }
    if (port === s.port) {
      setPortDraft(null);
      return;
    }
    put.mutate({ port }, { onSuccess: () => setPortDraft(null) });
  };

  return (
    <Card title="Agent access">
      <p style={{ margin: 0, fontSize: font.sm, color: color.muted }}>
        Run a local MCP endpoint inside the app so coding agents can pull ready work orders and survey
        repositories — no terminal, no server to launch. Enabling this exposes the pinned project’s documents
        and work orders to any local process holding the token.
      </p>

      <FieldRow label="Agent access">
        <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={{ display: "flex", alignItems: "center", gap: space(2), fontSize: font.sm, cursor: "pointer" }}>
            <Switch
              testid="agent-access-toggle"
              ariaLabel="Agent access"
              checked={s.enabled}
              disabled={busy}
              onChange={(next) => put.mutate({ enabled: next })}
            />
            {s.enabled ? "Enabled" : "Disabled"}
          </label>
        </div>
      </FieldRow>

      <FieldRow label="Port">
        <div style={{ display: "flex", flexDirection: "column", gap: space(1), flex: 1, minWidth: 0 }}>
          <form
            style={{ display: "flex", gap: space(2), alignItems: "center" }}
            onSubmit={(e) => {
              e.preventDefault();
              submitPort();
            }}
          >
            <Input
              aria-label="Agent access port"
              inputMode="numeric"
              value={portDraft ?? String(s.port)}
              disabled={busy}
              onChange={(e) => setPortDraft(e.target.value)}
              style={{ width: 100 }}
            />
            {portDraft !== null && portDraft !== String(s.port) && (
              <Button variant="ghost" type="submit" disabled={busy}>
                Apply
              </Button>
            )}
          </form>
          {/* The single status line (running/stopped/error) sits beside the
              port field so a bind conflict — or a removed-pin reason — reads
              exactly where the user would act on it. */}
          <div
            data-testid="agent-access-status"
            style={{ display: "flex", alignItems: "center", gap: space(2), fontSize: font.sm, color: STATUS_TONE[line.tone] }}
          >
            <span
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: 999, background: STATUS_TONE[line.tone], flexShrink: 0 }}
            />
            {line.text}
          </div>
        </div>
      </FieldRow>

      <FieldRow label="Project">
        <div style={{ display: "flex", flexDirection: "column", gap: space(1), flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: font.sm, color: s.project ? color.text : color.muted }}>
            {s.project ? s.project.name : "No project pinned"}
          </span>
          {repin && (
            <div
              data-testid="agent-access-repin"
              style={{ display: "flex", alignItems: "center", gap: space(2), flexWrap: "wrap" }}
            >
              <span style={{ fontSize: font.xs, color: color.muted }}>
                {repin.pinnedName
                  ? `The app is on “${repin.activeName}” but agents are served “${repin.pinnedName}”.`
                  : `The app is on “${repin.activeName}”.`}
              </span>
              <Button variant="ghost" disabled={busy} onClick={() => pin.mutate(repin.activeId)}>
                Serve “{repin.activeName}”
              </Button>
            </div>
          )}
        </div>
      </FieldRow>

      {showConnection(s) && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: space(3) }}>
            <Snippet label="Register with Claude Code" text={claudeMcpAddCommand(s)} />
            <Snippet label="Or add to an MCP config file" text={jsonConfigSnippet(s)} />
          </div>

          <FieldRow label="Token">
            {confirmingRegen ? (
              <div style={{ display: "flex", alignItems: "center", gap: space(2), flexWrap: "wrap" }}>
                <span style={{ fontSize: font.xs, color: color.warn }}>
                  Regenerating severs any connected agent until it reconnects. Continue?
                </span>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => regen.mutate(undefined, { onSettled: () => setConfirmingRegen(false) })}
                >
                  Regenerate
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmingRegen(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmingRegen(true)}>
                Regenerate token
              </Button>
            )}
          </FieldRow>
        </>
      )}

      <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
        The endpoint binds <code>127.0.0.1</code> only — never the network. The token is a local credential;
        anyone who can run a process on this machine and holds it can read and update the pinned project.
      </p>
    </Card>
  );
}

const PERIODS = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
] as const;
type Period = (typeof PERIODS)[number]["key"];

function UsageCard({ report }: { report: UsageReport }) {
  const [period, setPeriod] = useState<Period>("day");
  const buckets = period === "day" ? report.byDay : period === "week" ? report.byWeek : report.byMonth;

  if (report.totals.totalTokens === 0) {
    return (
      <Card title="Usage">
        <p data-testid="usage-empty" style={{ margin: 0, fontSize: font.sm, color: color.muted }}>
          No AI usage recorded yet — agent actions (draft, extract, chat, review) will appear here.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Usage">
      <div data-testid="usage-totals" style={{ display: "flex", flexWrap: "wrap", gap: space(4) }}>
        <Stat label="input tokens" value={fmtTokens(report.totals.inputTokens)} />
        <Stat label="output tokens" value={fmtTokens(report.totals.outputTokens)} />
        <Stat label="total tokens" value={fmtTokens(report.totals.totalTokens)} />
        <Stat label="est. cost" value={fmtUsd(report.totals.estimatedCostUsd)} />
      </div>
      {report.costIsPartial && (
        <p style={{ margin: 0, fontSize: font.xs, color: color.warn }}>
          Some recorded models have no published pricing — the estimate covers the rest.
        </p>
      )}

      {/* One visually-joined segmented group: outer border on the wrapper,
          inner buttons flat with a shared divider. */}
      <div
        style={{
          display: "inline-flex",
          alignSelf: "flex-start",
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          overflow: "hidden",
        }}
      >
        {PERIODS.map((p, i) => (
          <Button
            key={p.key}
            variant={period === p.key ? "primary" : "ghost"}
            aria-pressed={period === p.key}
            onClick={() => setPeriod(p.key)}
            style={{
              borderRadius: 0,
              border: "none",
              borderLeft: i === 0 ? "none" : `1px solid ${color.border}`,
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <UsageBars buckets={buckets} />

      <div style={{ display: "flex", gap: space(6), flexWrap: "wrap" }}>
        <BreakdownTable
          title="By feature"
          testid="usage-by-feature"
          rows={report.byFeature.map((f) => ({ name: f.feature, tokens: f.totalTokens, cost: f.estimatedCostUsd }))}
        />
        <BreakdownTable
          title="By model"
          testid="usage-by-model"
          rows={report.byModel.map((m) => ({ name: m.model, tokens: m.totalTokens, cost: m.estimatedCostUsd }))}
        />
      </div>

      <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
        Counted locally from calls made through this app; token counts only, never prompt or response text.
        Costs are estimates from published per-token pricing, not invoices.
      </p>
    </Card>
  );
}

// The page's three concerns as addressable sections: AI configuration is what
// people come to change (the default), Usage is a read-only dashboard that
// must not dominate the page on open.
const SECTIONS = [
  { key: "ai", label: "AI configuration" },
  { key: "agent", label: "Agent access" },
  { key: "skills", label: "Authoring skills" },
  { key: "usage", label: "Usage" },
] as const;
type Section = (typeof SECTIONS)[number]["key"];

export function SettingsView() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [keyInput, setKeyInput] = useState("");
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [section, setSection] = useState<Section>("ai");

  const closeKeyForm = () => {
    setKeyFormOpen(false);
    setKeyInput("");
  };

  const settings = useQuery({ queryKey: ["settings"], queryFn: api.aiSettings });
  // Fresh numbers every time Settings opens — model calls elsewhere in the app
  // don't invalidate ["usage"], so a mount-time refetch keeps the card honest.
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage, refetchOnMount: "always" });

  const put = useMutation({
    mutationFn: api.putAiSettings,
    onSuccess: () => {
      setKeyInput(""); // the raw key leaves the webview on save; never re-rendered
      setKeyFormOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      // the TopBar dot polls /health — invalidate so it flips immediately
      void queryClient.invalidateQueries({ queryKey: ["health"] });
    },
    onError: (e) => toast(friendlyError(e)),
  });

  if (settings.isPending) return <p style={{ color: color.muted }}>Loading settings…</p>;
  if (settings.isError || !settings.data) {
    return <p style={{ color: color.muted }}>{friendlyError(settings.error ?? new TypeError("unreachable"))}</p>;
  }
  const s = settings.data;

  return (
    <div data-testid="settings-view" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: space(5) }}>
      <h2 style={{ margin: 0 }}>Settings</h2>

      <div role="tablist" aria-label="Settings sections" style={{ display: "flex", gap: space(1.5) }}>
        {SECTIONS.map((sec) => (
          <Button
            key={sec.key}
            role="tab"
            aria-selected={section === sec.key}
            variant={section === sec.key ? "primary" : "ghost"}
            onClick={() => setSection(sec.key)}
          >
            {sec.label}
          </Button>
        ))}
      </div>

      {section === "ai" && (
      <Card title="AI configuration">
        <FieldRow label="Provider">
          {/* Anthropic is the only provider today — static text per the
              no-dead-UI rule. When a second provider lands, this reverts to a
              Select bound to s.provider via put.mutate({ provider }). */}
          <span style={{ fontSize: font.sm, color: color.text }}>Anthropic</span>
        </FieldRow>

        <FieldRow label="API key">
          {keyFormOpen ? (
            <form
              style={{ display: "flex", gap: space(2), alignItems: "center", flex: 1, minWidth: 0 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (keyInput.trim()) put.mutate({ apiKey: keyInput.trim() });
              }}
            >
              <Input
                aria-label="API key"
                type="password"
                autoComplete="off"
                autoFocus
                placeholder="Paste your Anthropic API key (sk-ant-…)"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeKeyForm();
                }}
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button variant="primary" type="submit" disabled={!keyInput.trim() || put.isPending}>
                Save
              </Button>
              <Button variant="ghost" type="button" onClick={closeKeyForm}>
                Cancel
              </Button>
            </form>
          ) : (
            <>
              <span data-testid="key-state" style={{ fontSize: font.sm, color: s.hasKey ? color.text : color.muted }}>
                {s.hasKey ? `Key saved · ends in ····${s.keyTail}` : "No key set"}
              </span>
              <Button variant="ghost" disabled={put.isPending} onClick={() => setKeyFormOpen(true)}>
                {s.hasKey ? "Replace key" : "Add key"}
              </Button>
              {s.hasKey && (
                <Button variant="ghost" disabled={put.isPending} onClick={() => put.mutate({ apiKey: null })}>
                  Remove
                </Button>
              )}
            </>
          )}
        </FieldRow>

        <FieldRow label="AI features">
          <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
            <label style={{ display: "flex", alignItems: "center", gap: space(2), fontSize: font.sm, cursor: "pointer" }}>
              {/* The checkbox stays the real control (testid + payload unchanged);
                  the styled track/thumb span is its visual. */}
              <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                <input
                  data-testid="ai-toggle"
                  type="checkbox"
                  role="switch"
                  aria-checked={s.enabled}
                  checked={s.enabled}
                  disabled={put.isPending}
                  onChange={(e) => {
                    // Capture now: by onSuccess time the controlled input has
                    // re-rendered from the (stale-until-refetch) query value.
                    const next = e.target.checked;
                    put.mutate(
                      { enabled: next },
                      { onSuccess: () => toast(next ? "AI features enabled" : "AI features disabled") },
                    );
                  }}
                  style={{ position: "absolute", inset: 0, opacity: 0, margin: 0, cursor: "pointer" }}
                />
                <span
                  aria-hidden
                  style={{
                    width: 34,
                    height: 20,
                    borderRadius: 10,
                    background: s.enabled ? color.accent : color.border,
                    transition: "background 120ms",
                    display: "inline-block",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      width: 16,
                      height: 16,
                      borderRadius: 8,
                      background: color.bg,
                      margin: 2,
                      transform: s.enabled ? "translateX(14px)" : "none",
                      transition: "transform 120ms",
                    }}
                  />
                </span>
              </span>
              {s.enabled ? "Enabled" : "Disabled"}
            </label>
            <span style={{ fontSize: font.xs, color: color.muted }}>
              Controls all AI features — while off, drafting, extraction, chat, and review are unavailable.
            </span>
          </div>
        </FieldRow>

        <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
          Your key is stored in the local Kiln database in plain text — the same trust boundary as a local
          <code> .env</code> file — and is only ever sent to the model provider. Kiln never proxies requests or
          manages billing: usage runs on your own account.
        </p>
      </Card>
      )}

      {section === "agent" && <AgentAccessCard />}

      {section === "skills" && <AuthoringSkillsCard />}

      {section === "usage" &&
        (usage.isPending ? (
          <p style={{ color: color.muted, fontSize: font.sm }}>Loading usage…</p>
        ) : usage.isError || !usage.data ? (
          <p style={{ color: color.muted, fontSize: font.sm }}>Usage unavailable — {friendlyError(usage.error)}</p>
        ) : (
          <UsageCard report={usage.data} />
        ))}
    </div>
  );
}
