import { useVox } from "../state/store";
import { PixelIcon } from "./PixelIcon";

export type ScreenKey = "voices" | "sounds" | "editor" | "ai" | "settings";

export const SCREENS: { key: ScreenKey; label: string }[] = [
  { key: "voices", label: "Voix" },
  { key: "sounds", label: "Sons" },
  { key: "editor", label: "Éditeur" },
  { key: "ai", label: "Voix IA" },
  { key: "settings", label: "Réglages" },
];

export function Sidebar({ screen, onNavigate }: { screen: ScreenKey; onNavigate: (s: ScreenKey) => void }) {
  const { snapshot } = useVox();
  const { status } = snapshot;
  return (
    <aside className="sidebar">
      <div className="logo">
        <PixelIcon name="mic" scale={2} color="var(--violet)" />
        <span className="logo__text">voxbox</span>
      </div>
      <nav aria-label="Navigation principale">
        <ul className="nav">
          {SCREENS.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                className="nav__item"
                aria-current={s.key === screen ? "page" : undefined}
                onClick={() => onNavigate(s.key)}
              >
                <span className="nav__bullet" aria-hidden="true" />
                {s.label}
                {s.key === "settings" && !status.cableFound ? (
                  <span className="nav__alert" title="VB-Cable introuvable">!</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <dl className="devbox">
        <dt>Micro</dt>
        <dd>{status.inputName ?? "Par défaut du système"}</dd>
        <dt>Sortie</dt>
        <dd className={status.cableFound ? undefined : "is-error"}>
          {status.cableFound ? shortCable(status.cableName) : "VB-Cable introuvable"}
        </dd>
        <dt>Latence</dt>
        <dd className="devbox__latency">
          {status.running ? `${Math.round(status.latencyMs)} ms` : "moteur arrêté"}
        </dd>
      </dl>
    </aside>
  );
}

function shortCable(name: string | null) {
  if (!name) return "CABLE Input · VB-Cable";
  return name.replace(/\s*\(VB-Audio Virtual Cable\)/i, " · VB-Cable");
}
