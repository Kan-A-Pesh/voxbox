import { useVox } from "../state/store";
import { PixelIcon } from "./PixelIcon";

export function Toasts() {
  const { toasts, dismiss } = useVox();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <PixelIcon name={t.kind === "error" ? "warning" : "check"} scale={1} />
          <span>{t.message}</span>
          <button type="button" className="icon-btn icon-btn--flat" aria-label="Fermer" onClick={() => dismiss(t.id)}>
            <PixelIcon name="close" scale={1} />
          </button>
        </div>
      ))}
    </div>
  );
}
