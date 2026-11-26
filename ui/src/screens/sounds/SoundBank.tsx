import { useMemo, useState, type CSSProperties } from "react";
import type { HotkeyBinding, Sound } from "../../ipc/contract";
import { useVox } from "../../state/store";
import { onGridKeyDown } from "../../lib/gridNav";
import { fold } from "../../lib/text";
import { reconcileSoundHotkeys } from "../../lib/hotkeys";
import { PixelIcon } from "../../components/PixelIcon";
import { Chips, EmptyState, IconButton } from "../../components/Controls";
import { SoundEditPanel } from "./SoundEditPanel";
import type { Progress } from "./useSoundProgress";

type SoundWrites = {
  /** The last write queued for this sound. */
  chain: Promise<boolean>;
  /** The record as last saved by the app. */
  confirmed: Sound;
  /** Changes not saved yet, oldest first, shown over `confirmed`. */
  pending: { patch: Partial<Sound> }[];
};

const soundWrites = new WeakMap<object, Map<string, SoundWrites>>();
function writesOf(backend: object): Map<string, SoundWrites> {
  let writes = soundWrites.get(backend);
  if (!writes) {
    writes = new Map();
    soundWrites.set(backend, writes);
  }
  return writes;
}

const ALL = "__all";
const FAV = "__fav";
const NONE = "__none";

export function SoundBank({ query, onClearQuery, progress, onStarting, onRefused, onImport, onExplore }: {
  query: string;
  onClearQuery: () => void;
  progress: Progress;
  /** A play was accepted (it may still be decoding). */
  onStarting: (id: string) => void;
  onRefused: (id: string) => void;
  onImport: () => void;
  onExplore: () => void;
}) {
  const { backend, snapshot, setSnapshot, call, soundCall } = useVox();
  const { sounds } = snapshot;
  const [filter, setFilter] = useState(ALL);
  const [editing, setEditing] = useState<string | null>(null);

  const categories = useMemo(
    () => [...new Set(sounds.map((s) => s.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, "fr")),
    [sounds],
  );

  const filterOptions = [
    { value: ALL, label: "Tous", count: sounds.length },
    { value: FAV, label: "Favoris", count: sounds.filter((s) => s.favorite).length },
    ...categories.map((c) => ({ value: c, label: c, count: sounds.filter((s) => s.category === c).length })),
    ...(sounds.some((s) => !s.category) ? [{ value: NONE, label: "Sans catégorie", count: sounds.filter((s) => !s.category).length }] : []),
  ];
  const activeFilter = filterOptions.some((o) => o.value === filter) ? filter : ALL;

  const q = fold(query.trim());
  const matching = sounds.filter(
    (s) =>
      (activeFilter === ALL ? true : activeFilter === FAV ? s.favorite : activeFilter === NONE ? !s.category : s.category === activeFilter) &&
      (!q || fold(s.name).includes(q)),
  );
  // In "Tous", favorites come first, each group in its usual order (sort is stable).
  const visible = activeFilter === ALL ? [...matching].sort((a, b) => Number(b.favorite) - Number(a.favorite)) : matching;

  async function toggle(s: Sound) {
    // A sound still decoding counts as playing: a second click stops it.
    if (progress[s.id]) {
      await soundCall((b, page) => b.invoke("stop_sound", { id: s.id, page }));
      return;
    }
    onStarting(s.id);
    const accepted = await soundCall((b, page, stops) => b.invoke("play_sound", { id: s.id, page, stops }).then(() => true));
    if (!accepted) onRefused(s.id);
  }

  // Writes to one sound run one after the other, each sending only its own fields on top
  // of the last saved record: a loop toggled on the pad while the editor saves is kept,
  // and an older answer never hides a newer change still on its way.
  // The queues outlive this view (switching tabs remounts it), one set per app.
  function saveSound(id: string, patch: Partial<Sound>): Promise<boolean> {
    const current = sounds.find((s) => s.id === id);
    if (!current) return Promise.resolve(false);
    const writes = writesOf(backend);
    let w = writes.get(id);
    if (!w) {
      w = { chain: Promise.resolve(true), confirmed: current, pending: [] };
      writes.set(id, w);
    }
    const state = w;
    const entry = { patch };
    state.pending.push(entry);
    const shown = (): Sound => Object.assign({}, state.confirmed, ...state.pending.map((p) => p.patch));
    setSnapshot((snap) => ({ ...snap, sounds: snap.sounds.map((x) => (x.id === id ? shown() : x)) }));
    const run = state.chain.then(async () => {
      const before = state.confirmed;
      const saved = await call("update_sound", { sound: { ...before, ...patch } });
      if (saved) state.confirmed = saved;
      let hotkeys: HotkeyBinding[] | undefined;
      // update_sound leaves the shortcut alone: it has its own command.
      if (saved && patch.hotkey !== undefined && patch.hotkey !== before.hotkey) {
        hotkeys = await call("set_hotkey", { action: { type: "sound", id }, accelerator: patch.hotkey });
        if (hotkeys) state.confirmed = { ...state.confirmed, hotkey: patch.hotkey };
      }
      state.pending = state.pending.filter((p) => p !== entry);
      if (state.pending.length === 0 && writes.get(id) === state) writes.delete(id);
      setSnapshot((snap) => {
        const keys = hotkeys ?? snap.hotkeys;
        const next = snap.sounds.map((x) => (x.id === id ? shown() : x));
        return { ...snap, hotkeys: keys, sounds: hotkeys ? reconcileSoundHotkeys(next, keys) : next };
      });
      return !!saved;
    });
    state.chain = run;
    return run;
  }

  async function deleteSound(id: string) {
    const ok = await call("delete_sound", { id });
    if (ok === undefined) return;
    setEditing(null);
    setSnapshot((snap) => ({
      ...snap,
      sounds: snap.sounds.filter((x) => x.id !== id),
      hotkeys: snap.hotkeys.filter((h) => !(h.action.type === "sound" && h.action.id === id)),
    }));
  }

  const editedSound = sounds.find((s) => s.id === editing) ?? null;

  return (
    <div className={`with-panel${editedSound ? " has-panel" : ""}`}>
      <div className="bank">
        {sounds.length > 0 ? <Chips label="Filtrer les sons" options={filterOptions} value={activeFilter} onChange={setFilter} /> : null}

        {sounds.length === 0 ? (
          <EmptyState
            icon="download"
            title="Ta banque est vide"
            action={
              <div className="row">
                <button type="button" className="btn btn--primary" onClick={onImport}>Importer des sons</button>
                <button type="button" className="btn" onClick={onExplore}>Explorer MyInstants</button>
              </div>
            }
          >
            Glisse des fichiers mp3, wav, ogg ou flac ici, ou pioche dans les sons populaires.
          </EmptyState>
        ) : visible.length === 0 ? (
          q ? (
            <EmptyState
              icon="search"
              title={`Aucun son ne correspond à « ${query.trim()} »`}
              action={<button type="button" className="btn" onClick={onClearQuery}>Effacer la recherche</button>}
            />
          ) : (
            <EmptyState icon="favorite" title="Aucun son ici">
              Clique sur l'étoile d'un son pour le retrouver dans tes favoris.
            </EmptyState>
          )
        ) : (
          <ul className="pad-grid" aria-label="Sons de ta banque" onKeyDown={onGridKeyDown}>
            {visible.map((s) => (
              <Pad
                key={s.id}
                sound={s}
                progress={progress}
                editing={s.id === editing}
                onToggle={() => toggle(s)}
                onFavorite={() => void saveSound(s.id, { favorite: !s.favorite })}
                onLoop={() => void saveSound(s.id, { loop: !s.loop })}
                onEdit={() => setEditing(s.id === editing ? null : s.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {editedSound ? (
        <SoundEditPanel
          key={editedSound.id}
          sound={editedSound}
          categories={categories}
          onSave={(patch) => saveSound(editedSound.id, patch)}
          onDelete={() => deleteSound(editedSound.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function Pad({ sound, progress, editing, onToggle, onFavorite, onLoop, onEdit }: {
  sound: Sound;
  progress: Progress;
  editing: boolean;
  onToggle: () => void;
  onFavorite: () => void;
  onLoop: () => void;
  onEdit: () => void;
}) {
  const p = progress[sound.id];
  const ratio = p && p.durationMs > 0 ? p.positionMs / p.durationMs : 0;
  return (
    <li
      className={`pad${p ? " is-playing" : ""}${editing ? " is-editing" : ""}${sound.favorite ? " is-favorite" : ""}${sound.color ? " has-color" : ""}`}
      style={sound.color ? ({ "--pad-color": sound.color } as CSSProperties) : undefined}
    >
      <button
        type="button"
        data-grid-item
        className="pad__main"
        onClick={onToggle}
        title={sound.name}
        aria-label={`${p ? "Arrêter" : "Jouer"} ${sound.name}`}
      >
        <PixelIcon name={p ? "stop" : "play"} scale={2} className="pad__glyph" />
        <span className="pad__text">
          <span className="pad__name">{sound.name}</span>
          <span className="pad__meta">
            {sound.favorite ? (
              <span className="pad__fav" title="Favori">
                <PixelIcon name="star" scale={1} />
              </span>
            ) : null}
            {sound.hotkey ? <kbd>{sound.hotkey}</kbd> : null}
            {sound.loop ? (
              <span className="pad__loop" title="Lecture en boucle">
                <PixelIcon name="loop" scale={1} />
              </span>
            ) : null}

          </span>
        </span>
      </button>
      <div className="pad__tools">
        <IconButton
          icon={sound.favorite ? "star" : "favorite"}
          size={1}
          label={sound.favorite ? `Retirer ${sound.name} des favoris` : `Ajouter ${sound.name} aux favoris`}
          pressed={sound.favorite}
          tone="accent"
          onClick={onFavorite}
        />
        <IconButton
          icon="loop"
          size={1}
          label={sound.loop ? `Ne plus jouer ${sound.name} en boucle` : `Jouer ${sound.name} en boucle`}
          pressed={sound.loop}
          onClick={onLoop}
        />
        <IconButton icon="pencil" size={1} label={`Modifier ${sound.name}`} pressed={editing} onClick={onEdit} />
      </div>
      {p ? (
        <span className="pad__progress" aria-hidden="true">
          <span style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
      ) : null}
    </li>
  );
}
