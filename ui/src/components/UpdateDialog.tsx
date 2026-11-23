import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { ErrorPanel, ProgressBar } from "./Controls";
import { useUpdateDialogShown, useUpdates } from "../state/updates";

/** Marks the control focus returns to when the pop-up closes and its opener is gone (the banner's action). */
const UPDATE_RETURN_ATTR = "data-update-return";

/**
 * Pop-up offering a newer release. Modal: the app behind it is inert and focus stays inside
 * (Tab wraps, a click on the backdrop keeps it); Esc = « Plus tard ».
 */
export function UpdateDialog() {
  const { phase, currentVersion, install, later } = useUpdates();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const open = useUpdateDialogShown();

  const installing = phase.kind === "installing";

  // Layout effects: focus moves in the same commit that shows the pop-up, never a frame later.
  // Back to where the user was when the pop-up closes (captured before focus moves inside). The
  // opener may be gone (the banner hides while the pop-up is open): its action then takes focus,
  // once the commit that brings it back is done.
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      queueMicrotask(() => {
        const target =
          previous?.isConnected && previous !== document.body
            ? previous
            : document.querySelector<HTMLElement>(`[${UPDATE_RETURN_ATTR}]`);
        target?.focus({ preventScroll: true });
      });
    };
  }, [open]);

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

  // First enabled button, or the dialog itself while installing (its button is disabled).
  useLayoutEffect(() => {
    if (!open) return;
    const target = ref.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? ref.current;
    target?.focus({ preventScroll: true });
  }, [open, installing]);

  // Keys are handled at the document: they work even if focus was lost (e.g. to the body).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        later();
      } else if (e.key === "Tab") {
        trapFocus(e, ref.current);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, later]);

  if (!open || phase.kind === "none") return null;
  const { version } = phase.update;

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
          {installing ? `Mise à jour vers ${version}` : `VoxBox ${version} est disponible`}
        </h2>
        {phase.kind === "installing" ? (
          <div className="modal__body" id={`${id}-text`}>
            <p>{phase.finished ? "Installation… VoxBox redémarre tout seul dans un instant." : "Téléchargement…"}</p>
            <ProgressBar value={phase.finished ? 1 : phase.progress ?? 0} label="Téléchargement de la mise à jour" />
            <p className="hint">Si Windows demande une autorisation, réponds « Oui ».</p>
          </div>
        ) : (
          <div className="modal__body" id={`${id}-text`}>
            {phase.kind === "failed" ? (
              <ErrorPanel title="La mise à jour n’a pas pu se faire" message={phase.message} />
            ) : (
              <p>
                Tu as la version {currentVersion ?? "actuelle"}. VoxBox télécharge la nouvelle, l’installe puis
                redémarre tout seul. Tes réglages, voix et sons sont conservés.
              </p>
            )}
            <p className="hint">Windows te demandera une autorisation pendant l’installation.</p>
          </div>
        )}
        <div className="modal__actions">
          <button type="button" className="btn btn--primary" disabled={installing} onClick={install}>
            {phase.kind === "failed" ? "Réessayer" : "Mettre à jour"}
          </button>
          {installing ? null : (
            <button type="button" className="btn btn--ghost" onClick={later}>
              Plus tard
            </button>
          )}
        </div>
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
  const active = document.activeElement;
  if (!first || !last) {
    e.preventDefault();
    root.focus();
    return;
  }
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
