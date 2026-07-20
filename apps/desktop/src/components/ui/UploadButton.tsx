import { useRef, type ReactNode } from "react";
import { Button } from "./Button";

// Styled replacement for a bare <input type="file">: renders as a Button,
// keeps the input visually hidden but still labelled for tests/a11y.
export function UploadButton({
  label,
  children,
  disabled,
  onFileChosen,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onFileChosen: (files: FileList | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        aria-label={label}
        style={{ display: "none" }}
        onChange={(e) => {
          onFileChosen(e.target.files);
          e.target.value = "";
        }}
      />
      <Button disabled={disabled} onClick={() => input.current?.click()}>
        {children}
      </Button>
    </>
  );
}
