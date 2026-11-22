import { useState } from "react";
import { useVox } from "../state/store";
import { PixelIcon } from "../components/PixelIcon";
import { SearchField } from "../components/Controls";
import { SoundBank } from "./sounds/SoundBank";
import { Explorer } from "./sounds/Explorer";
import { useSoundImport } from "./sounds/useSoundImport";
import { useSoundProgress } from "./sounds/useSoundProgress";

type Tab = "bank" | "explore";

const TABS: { key: Tab; label: string }[] = [
  { key: "bank", label: "Ma banque" },
  { key: "explore", label: "MyInstants" },
];

export function SoundsScreen() {
  const { call } = useVox();
  const [tab, setTab] = useState<Tab>("bank");
  const [bankQuery, setBankQuery] = useState("");
  const [remoteQuery, setRemoteQuery] = useState("");
  const progress = useSoundProgress();
  const { dragging, pickAndImport } = useSoundImport();
  const playing = Object.keys(progress).length;

  return (
    <section className="page page--split" aria-labelledby="sounds-title">
      <header className="page__head">
        <h1 className="page__title" id="sounds-title">Sons</h1>
        <div className="tabs" role="tablist" aria-label="Sources de sons">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`panel-${t.key}`}
              className="tab"
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  const next = tab === "bank" ? "explore" : "bank";
                  setTab(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }
              }}
              tabIndex={tab === t.key ? 0 : -1}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "bank" ? (
          <SearchField label="Rechercher un son" placeholder="Rechercher" value={bankQuery} onChange={setBankQuery} />
        ) : (
          <SearchField label="Rechercher sur MyInstants" placeholder="Rechercher" value={remoteQuery} onChange={setRemoteQuery} />
        )}
        <div className="page__actions">
          <button type="button" className="btn" onClick={() => call("stop_all_sounds", {})} disabled={playing === 0}>
            <PixelIcon name="stop" scale={1} /> Tout arrêter
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={pickAndImport}
            title="Ou glisse des fichiers audio n'importe où dans la fenêtre"
          >
            <PixelIcon name="folder" scale={1} /> Importer
          </button>
        </div>
      </header>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabpanel">
        {tab === "bank" ? (
          <SoundBank
            query={bankQuery}
            onClearQuery={() => setBankQuery("")}
            progress={progress}
            onImport={pickAndImport}
            onExplore={() => setTab("explore")}
          />
        ) : (
          <Explorer query={remoteQuery} onClearQuery={() => setRemoteQuery("")} />
        )}
      </div>
      {dragging ? (
        <div className="dropzone" aria-hidden="true">
          <PixelIcon name="download" scale={4} />
          <p>Lâche tes sons ici</p>
          <p className="hint">mp3 · wav · ogg · flac</p>
        </div>
      ) : null}
    </section>
  );
}
