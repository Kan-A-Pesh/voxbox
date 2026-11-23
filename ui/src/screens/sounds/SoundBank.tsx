import { useMemo, useState } from "react";
import type { Sound } from "../../ipc/contract";
import { useVox } from "../../state/store";
import { onGridKeyDown } from "../../lib/gridNav";
import { fold } from "../../lib/text";
import { reconcileSoundHotkeys } from "../../lib/hotkeys";
import { PixelIcon } from "../../components/PixelIcon";
import { Chips, EmptyState, IconButton } from "../../components/Controls";
import { SoundEditPanel } from "./SoundEditPanel";
import type { Progress } from "./useSoundProgress";

const ALL = "__all";
const FAV = "__fav";
const NONE = "__none";

export function SoundBank({ query, onClearQuery, progress, onImport, onExplore }: {
  query: string;
  onClearQuery: () => void;
  progress: Progress;
  onImport: () => void;
  onExplore: () => void;
}) {
  const { snapshot, setSnapshot, call } = useVox();
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
  const visible = sounds.filter(
    (s) =>
      (activeFilter === ALL ? true : activeFilter === FAV ? s.favorite : activeFilter === NONE ? !s.category : s.category === activeFilter) &&
      (!q || fold(s.name).includes(q)),
  );

  async function toggle(s: Sound) {
    if (progress[s.id]) await call("stop_sound", { id: s.id });
    else await call("play_sound", { id: s.id });
  }

  async function saveSound(next: Sound) {
    const prev = sounds.find((s) => s.id === next.id);
    setSnapshot((snap) => ({ ...snap, sounds: snap.sounds.map((x) => (x.id === next.id ? next : x)) }));
    const saved = await call("update_sound", { sound: next });
    if (!saved) {
      if (prev) setSnapshot((snap) => ({ ...snap, sounds: snap.sounds.map((x) => (x.id === next.id ? prev : x)) }));
      return false;
    }
    let hotkeys = snapshot.hotkeys;
    if (prev?.hotkey !== next.hotkey) {
      hotkeys = (await call("set_hotkey", { action: { type: "sound", id: next.id }, accelerator: next.hotkey })) ?? hotkeys;
    }
    setSnapshot((snap) => ({
      ...snap,
      hotkeys,
      sounds: reconcileSoundHotkeys(snap.sounds.map((x) => (x.id === saved.id ? saved : x)), hotkeys),
    }));
    return true;
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
                onFavorite={() => saveSound({ ...s, favorite: !s.favorite })}
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
          onSave={saveSound}
          onDelete={() => deleteSound(editedSound.id)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function Pad({ sound, progress, editing, onToggle, onFavorite, onEdit }: {
  sound: Sound;
  progress: Progress;
  editing: boolean;
  onToggle: () => void;
  onFavorite: () => void;
  onEdit: () => void;
}) {
  const p = progress[sound.id];
  const ratio = p && p.durationMs > 0 ? p.positionMs / p.durationMs : 0;
  return (
    <li className={`pad${p ? " is-playing" : ""}${editing ? " is-editing" : ""}${sound.favorite ? " is-favorite" : ""}`}>
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
                <PixelIcon name="loop" scale={1} /> boucle
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
