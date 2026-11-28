import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * A modal pop-up (app update, Voix IA pack update). The app behind it is inert and focus stays
 * inside (Tab wraps, a click on the backdrop keeps it); Esc calls `onEscape`. When it closes,
 * focus goes back to where the user was, or to the element matching `returnSelector` when that
 * one is gone (e.g. a banner action hidden while the pop-up is open).
 */
export function Modal({ open, title, onEscape, focusKey, returnSelector, children, actions }: {
  open: boolean;
  title: ReactNode;
  onEscape: () => void;
  /** Focus moves to the first enabled button again when this changes (e.g. buttons disabled while busy). */
  focusKey?: unknown;
  returnSelector: string;
  /** Content of the body (`.modal__body`, the dialog's description). */
  children: ReactNode;
  actions: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);

  // Layout effects: focus moves in the same commit that shows the pop-up, never a frame later.
  // Back to where the user was when the pop-up closes (captured before focus moves inside). The
  // opener may be gone: the `returnSelector` element then takes focus, once the commit that
  // brings it back is done.
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      queueMicrotask(() => {
        const target =
          previous?.isConnected && previous !== document.body
            ? previous
            : document.querySelector<HTMLElement>(returnSelector);
        target?.focus({ preventScroll: true });
      });
    };
  }, [open, returnSelector]);

  // The rest of the app can be neither focused nor clicked while the pop-up is open.
  useLayoutEffect(() => {
    const root = backdrop.current?.parentElement;
    if (!open || !root) return;
    const others = [...root.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== backdrop.current);
    const made = others.filter((el) => !el.hasAttribute("inert"));
    for (const el of made) el.setAttribute("inert", "");
    return () => {
      for (const el of made) el.removeAttribute("inert");
    };
  }, [open]);

  // First enabled button, or the dialog itself while its buttons are disabled.
  useLayoutEffect(() => {
    if (!open) return;
    const target = ref.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? ref.current;
    target?.focus({ preventScroll: true });
  }, [open, focusKey]);

  // Keys are handled at the document: they work even if focus was lost (e.g. to the body).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscape();
      } else if (e.key === "Tab") {
        trapFocus(e, ref.current);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onEscape]);

  if (!open) return null;

  return (
    // A click on the backdrop must not move focus out of the dialog (text inside stays selectable).
    <div
      ref={backdrop}
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-text`}
        tabIndex={-1}
      >
        <h2 className="modal__title" id={`${id}-title`}>
          {title}
        </h2>
        <div className="modal__body" id={`${id}-text`}>
          {children}
        </div>
        <div className="modal__actions">{actions}</div>
      </div>
    </div>
  );
}

/** Tab wraps inside the dialog; from anywhere else it goes back in. */
function trapFocus(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const focusables = [...root.querySelectorAll<HTMLElement>("button:not(:disabled)")];
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!first || !last) {
    e.preventDefault();
    root.focus();
    return;
  }
  const active = document.activeElement;
  if (!(active instanceof Node) || !root.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
