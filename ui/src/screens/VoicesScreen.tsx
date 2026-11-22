import { useMemo, useState } from "react";
import type { VoiceCategory, VoicePreset } from "../ipc/contract";
import { useVox } from "../state/store";
import { acceleratorFor } from "../lib/hotkeys";
import { onGridKeyDown } from "../lib/gridNav";
import { PixelIcon } from "../components/PixelIcon";
import { Chips, EmptyState, SearchField } from "../components/Controls";

type Filter = "all" | VoiceCategory;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Toutes" },
  { value: "fun", label: "Fun" },
  { value: "effects", label: "Effets" },
  { value: "ai", label: "IA" },
  { value: "custom", label: "Mes voix" },
];

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function VoicesScreen({ onEdit }: { onEdit: (voiceId: string | null) => void }) {
  const { snapshot, setSnapshot, call } = useVox();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const voices = useMemo(() => {
    const q = fold(query.trim());
    return snapshot.voices.filter(
      (v) =>
        (filter === "all" || v.category === filter) &&
        (!q || fold(v.name).includes(q) || fold(v.description).includes(q)),
    );
  }, [snapshot.voices, filter, query]);

  async function select(v: VoicePreset) {
    const previous = snapshot.settings.activeVoiceId;
    setSnapshot((s) => ({ ...s, settings: { ...s.settings, activeVoiceId: v.id } }));
    const settings = await call("set_active_voice", { id: v.id });
    setSnapshot((s) => ({ ...s, settings: settings ?? { ...s.settings, activeVoiceId: previous } }));
  }

  return (
    <section className="page" aria-labelledby="voices-title">
      <header className="page__head">
        <h1 className="page__title" id="voices-title">Voix</h1>
        <SearchField label="Rechercher une voix" placeholder="rechercher une voix_" value={query} onChange={setQuery} />
      </header>
      <Chips label="Filtrer les voix" options={FILTERS} value={filter} onChange={setFilter} />

      {voices.length === 0 ? (
        query ? (
          <EmptyState
            icon="search"
            title={`Aucune voix ne correspond à « ${query} »`}
            action={<button type="button" className="btn" onClick={() => setQuery("")}>Effacer la recherche</button>}
          />
        ) : filter === "custom" ? (
          <EmptyState
            icon="wrench"
            title="Tu n'as pas encore créé de voix"
            action={<button type="button" className="btn btn--primary" onClick={() => onEdit(null)}>Créer une voix</button>}
          >
            Pars de zéro ou duplique une voix intégrée dans l'éditeur.
          </EmptyState>
        ) : (
          <EmptyState icon="bot" title="Aucune voix dans cette catégorie" />
        )
      ) : (
        <div className="voice-grid" role="list" aria-label="Voix disponibles" onKeyDown={onGridKeyDown}>
          {voices.map((v) => (
            <VoiceCard
              key={v.id}
              voice={v}
              active={v.id === snapshot.settings.activeVoiceId}
              accelerator={acceleratorFor(snapshot.hotkeys, { type: "voice", id: v.id })}
              onSelect={() => select(v)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function VoiceCard({ voice, active, accelerator, onSelect }: {
  voice: VoicePreset;
  active: boolean;
  accelerator: string | null;
  onSelect: () => void;
}) {
  return (
    <div role="listitem" className="voice-cell">
      <button
        type="button"
        data-grid-item
        className={`voice-card${active ? " is-active" : ""}`}
        aria-pressed={active}
        onClick={onSelect}
      >
        {active ? <span className="tag tag--active">Active</span> : null}
        {voice.category === "ai" ? <span className="tag tag--ai">IA</span> : null}
        <PixelIcon name={voice.icon} scale={5} color={voice.color} className="voice-card__icon" />
        <span className="voice-card__name">{voice.name}</span>
        <span className="voice-card__desc" title={voice.description}>{voice.description}</span>
        <span className="voice-card__key">{accelerator ?? "—"}</span>
      </button>
    </div>
  );
}
