import { useState } from "react";
import { SoundBank } from "./sounds/SoundBank";
import { Explorer } from "./sounds/Explorer";

type Tab = "bank" | "explore";

export function SoundsScreen() {
  const [tab, setTab] = useState<Tab>("bank");
  const tabs: { key: Tab; label: string }[] = [
    { key: "bank", label: "Ma banque" },
    { key: "explore", label: "Explorer MyInstants" },
  ];
  return (
    <section className="page" aria-labelledby="sounds-title">
      <header className="page__head">
        <h1 className="page__title" id="sounds-title">Sons</h1>
        <div className="tabs" role="tablist" aria-label="Sources de sons">
          {tabs.map((t) => (
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
      </header>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabpanel">
        {tab === "bank" ? <SoundBank onExplore={() => setTab("explore")} /> : <Explorer />}
      </div>
    </section>
  );
}
