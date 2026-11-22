import { useVox } from "../state/store";
import { acceleratorFor } from "../lib/hotkeys";
import { PixelIcon } from "./PixelIcon";
import { VuMeter } from "./VuMeter";
import { Toggle } from "./Controls";

export function BottomBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { snapshot, patchSettings } = useVox();
  const { settings, voices, hotkeys, status } = snapshot;
  const voice = voices.find((v) => v.id === settings.activeVoiceId);
  const acc = voice ? acceleratorFor(hotkeys, { type: "voice", id: voice.id }) : null;
  const on = settings.voiceEnabled;

  return (
    <footer className="bottombar">
      <div className="now">
        <PixelIcon name={voice?.icon ?? "wrench"} scale={3} color={on ? voice?.color : "var(--muted)"} />
        <span className="now__text">
          <span className="now__name">{voice?.name ?? "Aucune voix"}</span>
          <span className="now__meta">{on ? "voix active" : "voix coupée"}{acc ? ` · ${acc}` : ""}</span>
        </span>
      </div>
      <VuMeter />
      <button
        type="button"
        className="bar-btn"
        aria-pressed={settings.monitor}
        title="T'entendre dans le casque"
        onClick={() => patchSettings({ monitor: !settings.monitor })}
      >
        <PixelIcon name="headphones" scale={2} />
        M'entendre
      </button>
      {!status.running ? (
        <button type="button" className="bar-warning" onClick={onOpenSettings}>
          <PixelIcon name="warning" scale={1} />
          Moteur arrêté{status.restarting ? ", relance en cours" : ""} · voir Réglages
        </button>
      ) : null}
      <Toggle
        compact
        className="power"
        label="Changeur de voix"
        checked={on}
        onChange={(voiceEnabled) => patchSettings({ voiceEnabled })}
      />
    </footer>
  );
}
