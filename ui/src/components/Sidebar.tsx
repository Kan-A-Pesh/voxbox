import { useVox } from "../state/store";
import { PixelIcon } from "./PixelIcon";
import type { IconName } from "./icons";

export type ScreenKey = "voices" | "sounds" | "settings";

export const SCREENS: { key: ScreenKey; label: string; icon: IconName }[] = [
  { key: "voices", label: "Voix", icon: "mic" },
  { key: "sounds", label: "Sons", icon: "play" },
  { key: "settings", label: "Réglages", icon: "gear" },
];

export const isScreenKey = (s: string | null): s is ScreenKey => SCREENS.some((x) => x.key === s);

export function Sidebar({ screen, onNavigate }: { screen: ScreenKey; onNavigate: (s: ScreenKey) => void }) {
  const { snapshot } = useVox();
  const { status } = snapshot;
  const alert = !status.cableFound ? "VB-Cable introuvable" : !status.running ? "Moteur audio arrêté" : null;
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
                <PixelIcon name={s.icon} scale={1} />
                {s.label}
                {s.key === "settings" && alert ? (
                  <span className="nav__alert" title={alert}>
                    <span className="sr-only">{alert}</span>
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
