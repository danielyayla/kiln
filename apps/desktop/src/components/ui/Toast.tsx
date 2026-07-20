import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { color, font, radius, shadow, space } from "../../theme";

type Variant = "error" | "success";

interface ToastItem {
  id: number;
  message: string;
  variant: Variant;
}

// push(message) from anywhere under the provider; toasts stack bottom-right,
// auto-dismiss after 6s, and dismiss on click (BP-6).
const ToastContext = createContext<(message: string, variant?: Variant) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, variant: Variant = "error") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          bottom: space(4),
          right: space(4),
          zIndex: 200,
          display: "grid",
          gap: space(2),
          maxWidth: 380,
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            data-testid="toast"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            style={{
              background: color.bg,
              border: `1px solid ${color.border}`,
              borderLeft: `3px solid ${t.variant === "error" ? color.danger : color.ok}`,
              borderRadius: radius.md,
              boxShadow: shadow,
              padding: `${space(2)}px ${space(3)}px`,
              fontSize: font.sm,
              cursor: "pointer",
            }}
            title="Click to dismiss"
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
