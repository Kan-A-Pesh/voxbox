import { useEffect, useState } from "react";
import { useVox } from "../../state/store";

export type Progress = Record<string, { positionMs: number; durationMs: number }>;

/** Playback positions from `engine` soundProgress / soundEnded events. */
export function useSoundProgress(): Progress {
  const { backend } = useVox();
  const [progress, setProgress] = useState<Progress>({});
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    backend
      .listen("engine", (e) => {
        if (e.type === "soundProgress") {
          setProgress((p) => ({ ...p, [e.id]: { positionMs: e.positionMs, durationMs: e.durationMs } }));
        } else if (e.type === "soundEnded") {
          setProgress((p) => {
            const next = { ...p };
            delete next[e.id];
            return next;
          });
        }
      })
      .then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [backend]);
  return progress;
}
