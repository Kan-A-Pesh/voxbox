import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./Controls";

/** Docked panel beside a page. Takes focus when it opens; Esc closes it. */
export function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      className="side-panel"
      aria-labelledby={`${id}-title`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="side-panel__head">
        <h2 className="side-panel__title" id={`${id}-title`}>{title}</h2>
        <IconButton icon="close" size={1} label="Fermer le panneau" onClick={onClose} />
      </div>
      {children}
    </aside>
  );
}
