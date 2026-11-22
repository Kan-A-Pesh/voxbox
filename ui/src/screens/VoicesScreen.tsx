import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { VoiceCategory, VoicePreset } from "../ipc/contract";
import { useVox } from "../state/store";
import { acceleratorFor } from "../lib/hotkeys";
import { onGridKeyDown } from "../lib/gridNav";
import { fold } from "../lib/text";
import { PixelIcon } from "../components/PixelIcon";
import { Chips, EmptyState, IconButton, SearchField } from "../components/Controls";
import { VoiceEditor } from "./voices/VoiceEditor";
import { AiVoicePanel } from "./voices/AiVoicePanel";
import { AiImportPanel } from "./voices/AiImportPanel";

type Filter = "all" | VoiceCategory;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Toutes" },
  { value: "fun", label: "Fun" },
  { value: "effects", label: "Effets" },
  { value: "ai", label: "IA" },
  { value: "custom", label: "Mes voix" },
];

/** What the side panel shows. `seq` remounts it on every open, so its draft starts fresh. */
type Panel =
  | { kind: "edit"; seq: number; voiceId: string | null; duplicateOf: string | null }
  | { kind: "ai"; seq: number; voiceId: string }
  | { kind: "import"; seq: number };
type WithoutSeq<P> = P extends unknown ? Omit<P, "seq"> : never;
type PanelRequest = WithoutSeq<Panel>;

const DISCARD = "Abandonner les modifications non enregistrées ?";

/** `leaveGuardRef` lets the app ask before navigating away from an unsaved voice draft. */
export function VoicesScreen({ leaveGuardRef }: { leaveGuardRef: RefObject<(() => boolean) | null> }) {
  const { snapshot, selectVoice } = useVox();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<Panel | null>(null);
  const seq = useRef(0);
  // The seq of the panel on screen: a late callback from a panel that is gone must not close its successor.
  const current = useRef(0);
  // The editor reports whether closing it would lose work.
  const unsaved = useRef(false);

  useEffect(() => {
    const guardRef = leaveGuardRef;
    guardRef.current = () => !unsaved.current || window.confirm(DISCARD);
    return () => {
      guardRef.current = null;
    };
  }, [leaveGuardRef]);

  const voices = useMemo(() => {
    const q = fold(query.trim());
    return snapshot.voices.filter(
      (v) =>
        (filter === "all" || v.category === filter) &&
        (!q || fold(v.name).includes(q) || fold(v.description).includes(q)),
    );
  }, [snapshot.voices, filter, query]);

  function openPanel(next: PanelRequest | null): boolean {
    if (unsaved.current && !window.confirm(DISCARD)) return false;
    unsaved.current = false;
    const opened = next ? { ...next, seq: ++seq.current } : null;
    current.current = opened?.seq ?? 0;
    setPanel(opened);
    return true;
  }

  /** Close the panel, unless another one replaced it meanwhile. */
  function closeIfCurrent(panelSeq: number) {
    if (current.current !== panelSeq) return;
    unsaved.current = false;
    current.current = 0;
    setPanel(null);
  }

  async function select(v: VoicePreset) {
    // The editor's live preview overrides the active voice: close it so the chosen voice is what goes on air.
    if (panel?.kind === "edit" && !openPanel(null)) return;
    await selectVoice(v.id);
  }

  function edit(v: VoicePreset) {
    if (v.aiModelId) openPanel({ kind: "ai", voiceId: v.id });
    else if (v.builtin) openPanel({ kind: "edit", voiceId: null, duplicateOf: v.id });
    else openPanel({ kind: "edit", voiceId: v.id, duplicateOf: null });
  }

  const openedId = panel?.kind === "ai" ? panel.voiceId : panel?.kind === "edit" ? panel.voiceId ?? panel.duplicateOf : null;
  const createTile =
    filter === "ai" ? (
      <button type="button" data-grid-item className="voice-new" onClick={() => openPanel({ kind: "import" })}>
        <PixelIcon name="download" scale={2} />
        Importer une voix IA
      </button>
    ) : (
      <button
        type="button"
        data-grid-item
        className="voice-new"
        onClick={() => openPanel({ kind: "edit", voiceId: null, duplicateOf: null })}
      >
        <PixelIcon name="plus" scale={2} />
        Créer une voix
      </button>
    );

  return (
    <div className={`with-panel${panel ? " has-panel" : ""}`}>
      <section className="page" aria-labelledby="voices-title">
        <header className="page__head">
          <h1 className="page__title" id="voices-title">Voix</h1>
          <SearchField label="Rechercher une voix" placeholder="Rechercher" value={query} onChange={setQuery} />
          <Chips label="Filtrer les voix" options={FILTERS} value={filter} onChange={setFilter} />
        </header>

        {voices.length === 0 && query ? (
          <EmptyState
            icon="search"
            title={`Aucune voix ne correspond à « ${query} »`}
            action={<button type="button" className="btn" onClick={() => setQuery("")}>Effacer la recherche</button>}
          />
        ) : (
          <div className="voice-grid" onKeyDown={onGridKeyDown}>
            <ul className="voice-grid__list" aria-label="Voix disponibles">
              {voices.map((v) => (
                <VoiceCard
                  key={v.id}
                  voice={v}
                  active={v.id === snapshot.settings.activeVoiceId}
                  opened={v.id === openedId}
                  accelerator={acceleratorFor(snapshot.hotkeys, { type: "voice", id: v.id })}
                  onSelect={() => select(v)}
                  onEdit={() => edit(v)}
                />
              ))}
            </ul>
            {createTile}
          </div>
        )}
        {voices.length === 0 && !query && filter === "custom" ? (
          <p className="page__note">Tu n'as pas encore de voix à toi : pars de zéro ou duplique une voix intégrée.</p>
        ) : null}
      </section>

      {panel?.kind === "edit" ? (
        <VoiceEditor
          key={panel.seq}
          voiceId={panel.voiceId}
          duplicateOf={panel.duplicateOf}
          onUnsavedChange={(u) => {
            unsaved.current = u;
          }}
          onClose={() => openPanel(null)}
          onDeleted={() => closeIfCurrent(panel.seq)}
        />
      ) : panel?.kind === "ai" ? (
        <AiVoicePanel
          key={panel.seq}
          voiceId={panel.voiceId}
          onClose={() => openPanel(null)}
          onDeleted={() => closeIfCurrent(panel.seq)}
        />
      ) : panel?.kind === "import" ? (
        <AiImportPanel
          key={panel.seq}
          onClose={() => openPanel(null)}
          onImported={(voiceId) => {
            if (current.current === panel.seq) openPanel(voiceId ? { kind: "ai", voiceId } : null);
          }}
        />
      ) : null}
    </div>
  );
}

function VoiceCard({ voice, active, opened, accelerator, onSelect, onEdit }: {
  voice: VoicePreset;
  active: boolean;
  opened: boolean;
  accelerator: string | null;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const action = voice.builtin && !voice.aiModelId ? "Dupliquer" : "Modifier";
  return (
    <li className={`voice${active ? " is-active" : ""}${opened ? " is-opened" : ""}`}>
      <button
        type="button"
        data-grid-item
        className="voice__main"
        aria-pressed={active}
        title={voice.description}
        onClick={onSelect}
      >
        <PixelIcon name={voice.icon} scale={3} color={voice.color} />
        <span className="voice__text">
          <span className="voice__name">
            {voice.name}
            {voice.category === "ai" ? <span className="tag-ai">IA</span> : null}
          </span>
          {accelerator ? <kbd className="voice__key">{accelerator}</kbd> : null}
        </span>
      </button>
      <IconButton
        className="voice__action"
        icon={action === "Dupliquer" ? "copy" : "pencil"}
        size={1}
        label={`${action} ${voice.name}`}
        onClick={onEdit}
      />
    </li>
  );
}
