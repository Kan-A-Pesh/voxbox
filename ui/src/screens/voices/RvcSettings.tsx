import { useEffect, useRef, useState } from "react";
import type { RvcParams } from "../../ipc/contract";
import { useVox } from "../../state/store";
import { Slider } from "../../components/Controls";
import { RVC_LIMITS, clampRvcParams, maxCrossfadeMs, sameRvcParams } from "../../lib/rvcParams";

/**
 * RVC settings, shared by every AI voice. Sliders move locally and reach the engine once the hand stops
 * (RVC reloads its stream on change); a change still pending when the sliders unmount is sent right away.
 */
export function RvcSettings() {
  const { snapshot, patchSettings } = useVox();
  const { settings } = snapshot;
  const [params, setParams] = useState<RvcParams>(settings.aiParams);

  // What the backend accepted is shown back, so the sliders never display a value that is not in use,
  // unless the sliders hold an edit not sent yet: that edit wins and is sent when the hand stops.
  const [accepted, setAccepted] = useState<RvcParams>(settings.aiParams);
  const [sent, setSent] = useState<RvcParams | null>(null);
  if (!sameRvcParams(accepted, settings.aiParams)) {
    setAccepted(settings.aiParams);
    const unsent = !sameRvcParams(params, accepted) && !(sent && sameRvcParams(params, sent));
    if (!unsent) setParams(settings.aiParams);
  }
  useEffect(() => {
    if (sameRvcParams(params, settings.aiParams)) return;
    const t = setTimeout(() => {
      setSent(params);
      void patchSettings({ aiParams: clampRvcParams(params) });
    }, 250);
    return () => clearTimeout(t);
  }, [params, settings.aiParams, patchSettings]);

  const pending = useRef({ params, accepted: settings.aiParams, patchSettings });
  useEffect(() => {
    pending.current = { params, accepted: settings.aiParams, patchSettings };
  });
  useEffect(
    () => () => {
      const { params: last, accepted: inUse, patchSettings: patch } = pending.current;
      if (!sameRvcParams(last, inUse)) void patch({ aiParams: clampRvcParams(last) });
    },
    [],
  );

  return (
    <div className="stack">
      <Slider
        label="Hauteur"
        value={params.pitchSemitones}
        {...RVC_LIMITS.pitchSemitones}
        format={(v) => `${v > 0 ? "+" : ""}${v} dt`}
        hint="+12 pour passer d'une voix d'homme à une voix de femme, -12 pour l'inverse."
        onChange={(pitchSemitones) => setParams((p) => ({ ...p, pitchSemitones }))}
      />
      <Slider
        label="Taux d'index"
        value={params.indexRate}
        {...RVC_LIMITS.indexRate}
        format={(v) => `${Math.round(v * 100)} %`}
        hint="Plus haut : timbre plus fidèle au modèle, articulation parfois moins nette."
        onChange={(indexRate) => setParams((p) => ({ ...p, indexRate }))}
      />
      <Slider
        label="Taille de bloc"
        value={params.blockMs}
        {...RVC_LIMITS.blockMs}
        format={(v) => `${v} ms`}
        hint="Bloc court = moins de latence, mais risque de craquements si le GPU ne suit pas."
        onChange={(blockMs) => setParams((p) => clampRvcParams({ ...p, blockMs }))}
      />
      <Slider
        label="Fondu entre blocs"
        value={params.crossfadeMs}
        min={RVC_LIMITS.crossfadeMs.min}
        max={maxCrossfadeMs(params.blockMs)}
        step={RVC_LIMITS.crossfadeMs.step}
        format={(v) => `${v} ms`}
        onChange={(crossfadeMs) => setParams((p) => ({ ...p, crossfadeMs }))}
      />
    </div>
  );
}
