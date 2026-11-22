import { useVox } from "../state/store";
import { PixelIcon } from "./PixelIcon";
import { IconButton } from "./Controls";

export function Toasts() {
  const { toasts, dismiss } = useVox();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <PixelIcon name={t.kind === "error" ? "warning" : "check"} scale={1} />
          <span>{t.message}</span>
          <IconButton icon="close" size={1} label="Fermer" onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}
