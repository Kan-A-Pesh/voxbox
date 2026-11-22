import { useEffect, useRef } from "react";
import { useVox } from "../state/store";

const BARS = 18;
const ROWS = 6;

/** Segmented pixel meter driven by `engine` meter events. Writes the DOM directly to avoid re-rendering at 15 Hz. */
export function VuMeter() {
  const { backend } = useVox();
  const ref = useRef<HTMLDivElement>(null);
  const history = useRef<number[]>(Array(BARS).fill(0));

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    backend
      .listen("engine", (e) => {
        if (e.type !== "meter" || !ref.current) return;
        // -60 dB .. 0 dB -> 0 .. ROWS
        const level = Math.round(Math.min(1, Math.max(0, (e.outputDb + 60) / 60)) * ROWS);
        history.current = [...history.current.slice(1), level];
        ref.current.querySelectorAll<HTMLElement>(".vu__bar").forEach((bar, i) => {
          bar.dataset.level = String(history.current[i] ?? 0);
        });
      })
      .then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [backend]);

  return (
    <div className="vu" ref={ref} role="img" aria-label="Niveau de sortie">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} className="vu__bar" data-level="0">
          {Array.from({ length: ROWS }, (_, r) => <span key={r} className="vu__cell" />)}
        </span>
      ))}
    </div>
  );
}
