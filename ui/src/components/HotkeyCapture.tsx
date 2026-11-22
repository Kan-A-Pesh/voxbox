import { useEffect, useRef, useState } from "react";
import { captureKey, captureMouse } from "../lib/accelerator";
import { PixelIcon } from "./PixelIcon";

interface Props {
  /** Accessible name, e.g. "Raccourci pour Robot". */
  label: string;
  value: string | null;
  onChange: (accelerator: string | null) => void;
  /** Returns a warning if the accelerator is already bound elsewhere. */
  conflict?: (accelerator: string) => string | null;
  id?: string;
}

/**
 * Click, then press the shortcut. Esc cancels, Backspace removes the binding.
 * Produces the accelerator syntax of the IPC contract ("Ctrl+Alt+1", "F13", "MouseX1").
 */
export function HotkeyCapture({ label, value, onChange, conflict, id }: Props) {
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!capturing) return;
    const stop = () => {
      setCapturing(false);
      setPreview(null);
    };
    const onMouse = (e: MouseEvent) => {
      const acc = captureMouse(e.button, e);
      if (acc) {
        e.preventDefault();
        commit(acc);
        stop();
      }
    };
    window.addEventListener("mousedown", onMouse, true);
    return () => window.removeEventListener("mousedown", onMouse, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  function commit(acc: string | null) {
    setMessage(acc ? conflict?.(acc) ?? null : null);
    onChange(acc);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    const r = captureKey(e);
    switch (r.kind) {
      case "pending":
        setPreview(r.preview);
        return;
      case "cancel":
        setMessage(null);
        break;
      case "clear":
        commit(null);
        break;
      case "invalid":
        setMessage(r.message);
        setPreview(null);
        return;
      case "accelerator":
        commit(r.accelerator);
        break;
    }
    setCapturing(false);
    setPreview(null);
  }

  return (
    <div className="hotkey">
      <div className="hotkey__row">
        <button
          id={id}
          ref={ref}
          type="button"
          className={`hotkey__btn${capturing ? " is-capturing" : ""}`}
          aria-label={`${label} : ${capturing ? "en écoute, appuie sur une touche" : value ?? "aucun"}`}
          onClick={() => {
            setMessage(null);
            setCapturing((c) => !c);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setCapturing(false);
            setPreview(null);
          }}
        >
          <PixelIcon name="keyboard" scale={1} />
          <span className="hotkey__value">
            {capturing ? preview ?? "Appuie sur une touche…" : value ?? "Aucun"}
          </span>
        </button>
        {value && !capturing ? (
          <button
            type="button"
            className="icon-btn icon-btn--flat"
            aria-label={`Retirer le raccourci (${label})`}
            title="Retirer le raccourci"
            onClick={() => {
              commit(null);
              ref.current?.focus();
            }}
          >
            <PixelIcon name="close" scale={1} />
          </button>
        ) : null}
      </div>
      <p className="hint" aria-live="polite">
        {capturing ? "Échap pour annuler · Retour arrière pour retirer" : message}
      </p>
    </div>
  );
}
