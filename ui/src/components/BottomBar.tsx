import { useVox } from "../state/store";
import { acceleratorFor } from "../lib/hotkeys";
import { PixelIcon } from "./PixelIcon";
import { Toggle } from "./Controls";
import { VuMeter } from "./VuMeter";

export function BottomBar() {
  const { snapshot, patchSettings } = useVox();
  const { settings, voices, hotkeys } = snapshot;
  const voice = voices.find((v) => v.id === settings.activeVoiceId);
  const acc = voice ? acceleratorFor(hotkeys, { type: "voice", id: voice.id }) : null;
  const on = settings.voiceEnabled;

  return (
    <footer className="bottombar">
      <div className="now">
        <span className="now__icon" style={{ borderColor: voice?.color }}>
          <PixelIcon name={voice?.icon ?? "wrench"} scale={2} color={on ? voice?.color : "var(--muted)"} />
        </span>
        <span className="now__text">
          <span className="now__name">{voice?.name ?? "Aucune voix"}</span>
          <span className="now__meta">{on ? "voix active" : "voix coupée"}{acc ? ` · ${acc}` : ""}</span>
        </span>
      </div>
      <VuMeter />
      <div className="bottombar__toggles">
        <Toggle compact label="M'entendre" checked={settings.monitor} onChange={(monitor) => patchSettings({ monitor })} />
        <Toggle compact label="Push-to-talk" checked={settings.pttMode} onChange={(pttMode) => patchSettings({ pttMode })} />
        <Toggle
          compact
          label="Anti-bruit"
          checked={settings.noiseSuppression}
          onChange={(noiseSuppression) => patchSettings({ noiseSuppression })}
        />
      </div>
      <button
        type="button"
        className={`power${on ? " is-on" : ""}`}
        aria-pressed={on}
        onClick={() => patchSettings({ voiceEnabled: !on })}
      >
        <span className="power__square" aria-hidden="true" />
        {on ? "Voix activée" : "Voix coupée"}
      </button>
    </footer>
  );
}
