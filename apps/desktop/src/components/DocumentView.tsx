import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Finding, WorkOrderCandidate } from "@kiln/agents";
import type { Criticality } from "@kiln/core";
import { api, ApiError } from "../lib/client";
import { copyText } from "../lib/clipboard";
import { CRITICALITIES, effectiveCriticality } from "../lib/criticality";
import { friendlyError } from "../lib/errors";
import { entityLink } from "../lib/route";
import { Editor } from "./Editor";
import { ProposalWalkBanner } from "./ProposalQueue";
import { RevisionDiff } from "./RevisionDiff";
import { Button, Select, useToast } from "./ui";
import { color, font, radius, space } from "../theme";

// Severity → token color for the findings panel chips (WO-C1).
const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  minor: color.muted,
  major: color.warn,
  critical: color.danger,
};

// Authoring-standards chips (methodology layer 2) share the inspector's
// severity palette.
const CHECK_COLOR: Record<"error" | "warn" | "info", string> = {
  error: color.danger,
  warn: color.warn,
  info: color.muted,
};

// Opens one entity as a document (BP-5): title, type, and body. The graph
// neighbourhood (blueprints, references, sub-requirements) lives in the
// GraphPanel beside this view. BP-6 adds the child_of breadcrumb path and
// click-to-edit titles.
export function DocumentView({
  entityId,
  onSelect,
  onDeleted,
}: {
  entityId: string;
  onSelect: (id: string) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [openRevisionId, setOpenRevisionId] = useState<string | null>(null);

  const entity = useQuery({
    queryKey: ["entity", entityId],
    queryFn: () => api.getEntity(entityId),
    // A stale/unknown id (e.g. from a deep link into a store that no longer has
    // it) is a 404, not a blip — resolve it to the not-found state at once
    // instead of retrying. Other failures keep the default retry.
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 3,
  });
  const isRequirement = entity.data?.type === "requirement";

  // child_of only applies to requirements — no query for the other types.
  const ancestors = useQuery({
    queryKey: ["ancestors", entityId],
    queryFn: () => api.ancestors(entityId),
    enabled: isRequirement,
  });

  // Restore writes through commitBody (exempt from the anchor lock) and
  // appends one new revision (BP-6).
  const restore = useMutation({
    mutationFn: (revisionId: string) => api.restore(entityId, revisionId),
    onSuccess: ({ entity: updated }) => {
      setOpenRevisionId(null);
      queryClient.setQueryData(["entity", entityId], updated);
      void queryClient.invalidateQueries({ queryKey: ["revisions", entityId] });
      toast("Revision restored.", "success");
    },
    onError: (e) => toast(friendlyError(e)),
  });

  const rename = useMutation({
    mutationFn: (title: string) => api.patchEntity(entityId, { title }),
    onSuccess: (updated) => {
      setTitleDraft(null);
      queryClient.setQueryData(["entity", entityId], updated);
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      void queryClient.invalidateQueries({ queryKey: ["ancestors"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
    },
  });

  const suggestions = useQuery({
    queryKey: ["suggestions", entityId],
    queryFn: () => api.suggestions(entityId),
  });
  // Per-document authoring-standards checks; keyed on updatedAt so an edited
  // body or a rename re-checks without explicit invalidation. Quiet on failure.
  const docHealth = useQuery({
    queryKey: ["doc-health", entityId, entity.data?.updatedAt],
    queryFn: () => api.documentHealth(entityId),
    enabled: entity.data !== undefined,
  });

  const revisions = useQuery({
    queryKey: ["revisions", entityId],
    queryFn: () => api.revisions(entityId),
  });

  // Criticality (verification & criticality): a plain field PATCH — the
  // store enforces the work_order-only rule; the selector only renders on
  // work orders anyway. Board badges/filters and the Pulse attention row all
  // read this field, so both refresh.
  const setCriticality = useMutation({
    mutationFn: (criticality: Criticality) => api.patchEntity(entityId, { criticality }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["entity", entityId], updated);
      void queryClient.invalidateQueries({ queryKey: ["entities", "work_order"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
    },
    onError: (e) => toast(friendlyError(e)),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteEntity(entityId),
    onSuccess: () => {
      // The deletion cascades edges server-side; refresh everything that could
      // have referenced this entity.
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      void queryClient.invalidateQueries({ queryKey: ["entities"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
      onDeleted();
    },
  });

  // Agent-assisted authoring (BP-4). The sidecar owns the model key; a 503
  // (no credentials) or 502 (model failure) surfaces as a friendly toast.
  const draft = useMutation({
    mutationFn: () => api.draft(entityId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["suggestions", entityId] }),
    onError: (e) => toast(friendlyError(e)),
  });

  const extract = useMutation({
    mutationFn: () => api.extract(entityId),
    onError: (e) => toast(friendlyError(e)),
  });

  // On-demand review (WO-C1): findings + optional fix ops. Nothing is filed
  // until the human clicks "Propose fixes".
  const proposeFixes = useMutation({
    mutationFn: (ops: NonNullable<Parameters<typeof api.fileSuggestion>[2]>) =>
      api.fileSuggestion(entityId, "review_agent", ops),
    onSuccess: () => {
      // The filed suggestion shows up as editor decorations.
      void queryClient.invalidateQueries({ queryKey: ["suggestions", entityId] });
      toast("Fixes filed as a suggestion — review them in the editor.", "success");
    },
    // The anchor-lock 400 ("resolve pending suggestions first") lands here.
    onError: (e) => toast(friendlyError(e)),
  });

  const review = useMutation({
    mutationFn: () => api.review(entityId),
    // A fresh review resets the previous run's filed state.
    onSuccess: () => proposeFixes.reset(),
    onError: (e) => toast(friendlyError(e)),
  });

  const accept = useMutation({
    mutationFn: (candidate: WorkOrderCandidate) => api.acceptCandidate(entityId, candidate),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["entities", "work_order"] });
      // New work orders surface in the navigator tree (BP-6).
      void queryClient.invalidateQueries({ queryKey: ["tree"] });
      void queryClient.invalidateQueries({ queryKey: ["pulse"] });
    },
    onError: (e) => toast(friendlyError(e)),
  });

  if (entity.isPending) return <p>loading…</p>;
  // A stale deep link or an id from another project: land on an in-view
  // not-found with a way out, never a blank canvas (Navigation & deep linking).
  if (!entity.data) {
    return (
      <div data-testid="entity-not-found" style={{ maxWidth: 460, margin: "12vh auto 0", textAlign: "center" }}>
        <h2 style={{ marginBottom: space(2) }}>Nothing here</h2>
        <p style={{ color: color.muted, fontSize: font.base, marginBottom: space(4) }}>
          <code style={{ fontSize: font.sm }}>{entityId.slice(0, 8)}</code> isn't in this project. It may have been
          deleted, or the link points at a different project's store.
        </p>
        <Button variant="primary" onClick={onDeleted}>
          Close
        </Button>
      </div>
    );
  }
  const e = entity.data;

  // Copy a shareable link straight to this document — the entity-header half of
  // the copy-location affordance (the TopBar copies the current location).
  const copyLink = () =>
    copyText(entityLink(e.id)).then(
      () => toast("Link to this document copied.", "success"),
      () => toast("Couldn't copy the link."),
    );

  // ancestors() is nearest-first; breadcrumbs read root-first.
  const path = [...(ancestors.data ?? [])].reverse();

  return (
    <article data-testid="document-view">
      <ProposalWalkBanner entityId={entityId} onSelect={onSelect} />
      {path.length > 0 && (
        <nav aria-label="Breadcrumbs" style={{ fontSize: font.sm, color: color.muted, marginBottom: space(1) }}>
          {path.map((a) => (
            <span key={a.id}>
              <button
                onClick={() => onSelect(a.id)}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  padding: 0,
                  color: color.muted,
                  fontSize: font.sm,
                  textDecoration: "underline",
                  textDecorationColor: color.border,
                }}
              >
                {a.title}
              </button>
              <span style={{ margin: `0 ${space(1)}px` }}>/</span>
            </span>
          ))}
          <span>{e.title}</span>
        </nav>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: space(2) }}>
        <p style={{ color: color.muted, margin: 0, fontSize: font.sm, display: "flex", alignItems: "baseline", gap: space(1) }}>
          {e.type}
          {e.status ? ` · ${e.status}` : ""} · {e.id.slice(0, 8)}
          {e.type === "work_order" && (
            <>
              <span aria-hidden> · </span>
              <label htmlFor="doc-criticality" style={{ fontSize: font.sm }}>
                criticality
              </label>
              <Select
                id="doc-criticality"
                aria-label="criticality"
                value={effectiveCriticality(e)}
                disabled={setCriticality.isPending}
                onChange={(ev) => setCriticality.mutate(ev.target.value as Criticality)}
                style={{ fontSize: font.xs, padding: `1px ${space(1.5)}px` }}
              >
                {CRITICALITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </>
          )}
        </p>
        <div style={{ display: "flex", gap: space(2), alignItems: "center", flexShrink: 0 }}>
          <Button variant="ghost" aria-label="Copy link" title="Copy link to this document" onClick={copyLink}>
            🔗
          </Button>
          <Button
            variant="danger"
            data-testid="delete-entity"
            onClick={() => {
              if (window.confirm(`Delete "${e.title}"? This also removes its links, suggestions, and revisions.`)) {
                remove.mutate();
              }
            }}
            disabled={remove.isPending}
          >
            Delete
          </Button>
        </div>
      </div>
      <h2 style={{ marginTop: space(1) }}>
        {titleDraft === null ? (
          <button
            data-testid="document-title"
            title="Click to rename"
            onClick={() => setTitleDraft(e.title)}
            style={{
              font: "inherit",
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "text",
              textAlign: "left",
            }}
          >
            {e.title}
          </button>
        ) : (
          <form
            style={{ display: "flex" }}
            onSubmit={(ev) => {
              ev.preventDefault();
              const next = titleDraft.trim();
              if (next && next !== e.title) rename.mutate(next);
              else setTitleDraft(null);
            }}
          >
            <input
              autoFocus
              aria-label="Document title"
              value={titleDraft}
              onChange={(ev) => setTitleDraft(ev.target.value)}
              onKeyDown={(ev) => ev.key === "Escape" && setTitleDraft(null)}
              onBlur={() => setTitleDraft(null)}
              style={{
                font: "inherit",
                flex: 1,
                minWidth: 0,
                border: "none",
                borderBottom: `1px solid ${color.borderStrong}`,
                background: "transparent",
                padding: 0,
                outline: "none",
              }}
            />
          </form>
        )}
      </h2>

      {(docHealth.data?.checks.length ?? 0) > 0 && (
        <div
          data-testid="doc-health"
          style={{ display: "flex", gap: space(1), flexWrap: "wrap", marginBottom: space(2) }}
        >
          {docHealth.data!.checks.map((k) => (
            <span
              key={k.code}
              title={k.message}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space(1),
                fontSize: font.xs,
                color: CHECK_COLOR[k.level],
                background: color.chip,
                border: `1px solid ${color.border}`,
                borderRadius: 999,
                padding: `1px ${space(2)}px`,
                whiteSpace: "nowrap",
              }}
            >
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: CHECK_COLOR[k.level] }} />
              {k.code}
            </span>
          ))}
        </div>
      )}

      {(e.type === "requirement" || e.type === "blueprint") && (
        <div style={{ display: "flex", gap: space(2), alignItems: "center", marginBottom: space(2), flexWrap: "wrap" }}>
          <Button
            data-testid="draft-with-agent"
            onClick={() => draft.mutate()}
            disabled={draft.isPending || (suggestions.data?.length ?? 0) > 0}
          >
            {draft.isPending ? "drafting…" : "Draft with agent"}
          </Button>
          {e.type === "blueprint" && (
            <Button data-testid="extract-work-orders" onClick={() => extract.mutate()} disabled={extract.isPending}>
              {extract.isPending ? "extracting…" : "Extract work orders"}
            </Button>
          )}
          <Button data-testid="review-document" onClick={() => review.mutate()} disabled={review.isPending}>
            {review.isPending ? "reviewing…" : "Review"}
          </Button>
        </div>
      )}

      {review.data && (
        <section
          data-testid="findings-panel"
          style={{
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            padding: space(2.5),
            marginBottom: space(2),
          }}
        >
          <p style={{ margin: `0 0 ${space(1.5)}px`, fontSize: font.sm, color: color.muted }}>
            {review.data.findings.length === 0
              ? "No findings — the document reads clean."
              : `${review.data.findings.length} finding${review.data.findings.length === 1 ? "" : "s"}`}
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: space(1.5) }}>
            {review.data.findings.map((f, i) => (
              <li key={i} style={{ fontSize: font.sm }}>
                <span
                  style={{
                    fontSize: font.xs,
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    color: SEVERITY_COLOR[f.severity],
                    marginRight: space(1.5),
                  }}
                >
                  {f.severity.toUpperCase()} · {f.kind}
                </span>
                {f.note}
                {f.quote && (
                  <blockquote
                    style={{
                      margin: `${space(1)}px 0 0 ${space(2)}px`,
                      paddingLeft: space(2),
                      borderLeft: `2px solid ${color.borderStrong}`,
                      color: color.muted,
                      fontStyle: "italic",
                    }}
                  >
                    {f.quote}
                  </blockquote>
                )}
              </li>
            ))}
          </ul>
          {review.data.ops && !proposeFixes.isSuccess && (
            <Button
              data-testid="propose-fixes"
              style={{ marginTop: space(2) }}
              onClick={() => proposeFixes.mutate(review.data!.ops!)}
              disabled={proposeFixes.isPending}
            >
              {proposeFixes.isPending
                ? "filing…"
                : `Propose fixes (${review.data.ops.length} op${review.data.ops.length === 1 ? "" : "s"})`}
            </Button>
          )}
        </section>
      )}

      {extract.data && (
        <section
          data-testid="candidate-panel"
          style={{
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            padding: space(2.5),
            marginBottom: space(2),
          }}
        >
          <p style={{ margin: `0 0 ${space(1.5)}px`, fontSize: font.sm, color: color.muted }}>
            {extract.data.candidates.length} candidate work order{extract.data.candidates.length === 1 ? "" : "s"} —
            accept the ones you want.
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {extract.data.candidates.map((c, i) => (
              <li key={i} style={{ display: "flex", gap: space(2), alignItems: "baseline", padding: "3px 0" }}>
                <span style={{ flex: 1, fontSize: font.sm }}>
                  <strong>{c.title}</strong> — {c.body}
                </span>
                <Button aria-label={`accept candidate ${i}`} onClick={() => accept.mutate(c)} disabled={accept.isPending}>
                  Accept
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Editor entity={e} suggestion={suggestions.data?.[0] ?? null} />
      {revisions.data && revisions.data.length > 0 && (
        <details style={{ marginTop: space(2) }}>
          <summary data-testid="revision-count" style={{ cursor: "pointer", fontSize: font.sm, color: color.muted }}>
            {revisions.data.length} revision{revisions.data.length === 1 ? "" : "s"}
          </summary>
          <ul style={{ listStyle: "none", margin: `${space(1.5)}px 0 0`, padding: 0, fontSize: font.sm }}>
            {revisions.data.map((r) => (
              <li key={r.id} style={{ marginBottom: space(1) }}>
                <button
                  aria-expanded={openRevisionId === r.id}
                  onClick={() => setOpenRevisionId(openRevisionId === r.id ? null : r.id)}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    cursor: "pointer",
                    fontSize: font.sm,
                    color: color.muted,
                    textDecoration: "underline",
                    textDecorationColor: color.border,
                  }}
                >
                  {new Date(r.createdAt).toLocaleString()} — {r.body.length} chars
                </button>
                {openRevisionId === r.id && (
                  <RevisionDiff
                    currentBody={e.body}
                    revision={r}
                    onRestore={() => restore.mutate(r.id)}
                    restoring={restore.isPending}
                  />
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
