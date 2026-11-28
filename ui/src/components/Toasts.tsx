import { useEffect } from "react";
import { useVox, type Toast } from "../state/store";
import { PixelIcon } from "./PixelIcon";
import { IconButton } from "./Controls";

/** On screen long enough to read: 300 ms per word, at least 3 s. */
export function toastDuration(message: string): number {
  return Math.max(3000, message.split(/\s+/).length * 300);
}

export function Toasts() {
  const { toasts, dismiss } = useVox();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  // The timer belongs to the toast on screen: it stops when the toast or the app goes away.
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), toastDuration(toast.message));
    return () => clearTimeout(timer);
  }, [toast.id, toast.message, onDismiss]);
  return (
    <div className={`toast toast--${toast.kind}`}>
      <PixelIcon name={toast.kind === "error" ? "warning" : "check"} scale={1} />
      <span>{toast.message}</span>
      <IconButton icon="close" size={1} label="Fermer" onClick={() => onDismiss(toast.id)} />
    </div>
  );
}
