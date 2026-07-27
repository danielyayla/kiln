import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { backdrop, color, font, radius, shadow, space } from "../../theme";

// In-app replacement for window.confirm/alert/prompt: promise-based, themed
// from the token layer, focus-trapped, Esc = cancel. One provider at the app
// root; callers await useDialog().confirm(...) etc. Requests queue, so a
// second dialog raised while one is open shows after it settles — native
// dialogs serialized the same way, just by blocking the event loop.

interface DialogOptions {
  /** Confirm-button label; defaults to "OK". */
  confirmLabel?: string;
  /** Style the confirm button in the danger tone (deletes). */
  danger?: boolean;
}

interface DialogApi {
  confirm(message: string, opts?: DialogOptions): Promise<boolean>;
  alert(message: string): Promise<void>;
  prompt(message: string, defaultValue?: string): Promise<string | null>;
}

type DialogKind = "confirm" | "alert" | "prompt";

interface DialogRequest extends DialogOptions {
  id: number;
  kind: DialogKind;
  message: string;
  defaultValue?: string;
  resolve: (result: boolean | string | null) => void;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useDialog must be used under <DialogProvider>");
  return api;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const nextId = useRef(0);

  const push = useCallback(
    (req: Omit<DialogRequest, "id" | "resolve">) =>
      new Promise<boolean | string | null>((resolve) => {
        setQueue((prev) => [...prev, { ...req, id: nextId.current++, resolve }]);
      }),
    [],
  );

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (message, opts) => push({ kind: "confirm", message, ...opts }) as Promise<boolean>,
      alert: (message) => push({ kind: "alert", message }).then(() => undefined),
      prompt: (message, defaultValue) =>
        push({ kind: "prompt", message, defaultValue }) as Promise<string | null>,
    }),
    [push],
  );

  const active = queue[0];
  const settle = (result: boolean | string | null) => {
    active?.resolve(result);
    setQueue((prev) => prev.slice(1));
  };

  return (
    <DialogContext.Provider value={api}>
      {children}
      {/* Keyed by request id so per-request state (the prompt value) resets. */}
      {active && <DialogCard key={active.id} request={active} onSettle={settle} />}
    </DialogContext.Provider>
  );
}

function DialogCard({
  request,
  onSettle,
}: {
  request: DialogRequest;
  onSettle: (result: boolean | string | null) => void;
}) {
  const [value, setValue] = useState(request.defaultValue ?? "");
  const cardRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cancel = () =>
    onSettle(request.kind === "confirm" ? false : request.kind === "prompt" ? null : true);
  const ok = () => onSettle(request.kind === "prompt" ? value : true);

  // Focus the natural target on open and hand focus back on close, so a
  // keyboard flow (RowMenu → dialog → back) never drops to <body>.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (request.kind === "prompt" ? inputRef.current : okRef.current)?.focus();
    return () => previous?.focus();
  }, [request.kind]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Tab") {
      // Minimal focus trap: cycle within the card's own controls.
      const focusables = Array.from(
        cardRef.current?.querySelectorAll<HTMLElement>("button, input") ?? [],
      );
      if (focusables.length === 0) return;
      const at = focusables.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? focusables[at <= 0 ? focusables.length - 1 : at - 1]
        : focusables[at === focusables.length - 1 ? 0 : at + 1];
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <div
      onClick={cancel}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: backdrop,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "24vh",
      }}
    >
      <div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={request.message}
        data-testid="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, 90vw)",
          background: color.bg,
          border: `1px solid ${color.borderStrong}`,
          borderRadius: radius.lg,
          boxShadow: shadow,
          padding: space(4),
          display: "grid",
          gap: space(3),
        }}
      >
        <p style={{ margin: 0, fontSize: font.sm, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {request.message}
        </p>
        {request.kind === "prompt" && (
          <input
            ref={inputRef}
            aria-label="Value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ok();
              }
            }}
            style={{
              width: "100%",
              padding: `${space(1.5)}px ${space(2)}px`,
              border: `1px solid ${color.border}`,
              borderRadius: radius.md,
              background: color.surface,
              fontSize: font.sm,
              color: color.text,
            }}
          />
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space(2) }}>
          {request.kind !== "alert" && <Button onClick={cancel}>Cancel</Button>}
          <Button
            ref={okRef}
            variant={request.danger ? "danger" : "primary"}
            data-testid="dialog-confirm"
            onClick={ok}
          >
            {request.confirmLabel ?? "OK"}
          </Button>
        </div>
      </div>
    </div>
  );
}
