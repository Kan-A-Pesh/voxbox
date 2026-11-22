import { useEffect, useMemo, useState } from "react";
import type { Sound } from "../../ipc/contract";
import { useVox } from "../../state/store";
import { onGridKeyDown } from "../../lib/gridNav";
import { reconcileSoundHotkeys } from "../../lib/hotkeys";
import { PixelIcon } from "../../components/PixelIcon";
import { Chips, EmptyState, IconButton, Slider } from "../../components/Controls";
import { SoundEditPanel } from "./SoundEditPanel";
import { useSoundProgress, type Progress } from "./useSoundProgress";

export const SOUND_EXTENSIONS = ["mp3", "wav", "ogg", "flac"];
const ALL = "__all";
const FAV = "__fav";
const NONE = "__none";

const pct = (v: number) => `${Math.round(v * 100)} %`;

export function SoundBank({ onExplore }: { onExplore: () => void }) {
  const { snapshot, setSnapshot, call, backend, notify, patchSettings } = useVox();
  const { sounds, settings } = snapshot;
  const progress = useSoundProgress();
  const [filter, setFilter] = useState(ALL);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const categories = useMemo(
    () => [...new Set(sounds.map((s) => s.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, "fr")),
    [sounds],
  );

  const filterOptions = [
    { value: ALL, label: "Tous", count: sounds.length },
    { value: FAV, label: "★ Favoris", count: sounds.filter((s) => s.favorite).length },
    ...categories.map((c) => ({ value: c, label: c, count: sounds.filter((s) => s.category === c).length })),
    ...(sounds.some((s) => !s.category) ? [{ value: NONE, label: "Sans catégorie", count: sounds.filter((s) => !s.category).length }] : []),
  ];
  const activeFilter = filterOptions.some((o) => o.value === filter) ? filter : ALL;

  const visible = sounds.filter((s) =>
    activeFilter === ALL ? true : activeFilter === FAV ? s.favorite : activeFilter === NONE ? !s.category : s.category === activeFilter,
  );

  async function importPaths(paths: string[]) {
    if (paths.length === 0) return;
    const added = await call("import_sounds", { paths });
    if (!added) return;
    setSnapshot((s) => ({ ...s, sounds: [...s.sounds, ...added] }));
    notify(added.length === 1 ? `« ${added[0]?.name} » ajouté à ta banque` : `${added.length} sons ajoutés à ta banque`);
  }

  async function pickAndImport() {
    try {
      const paths = await backend.pickFiles({ title: "Sons audio", extensions: SOUND_EXTENSIONS, multiple: true });
      if (paths) await importPaths(paths);
    } catch (e) {
      notify(`Impossible d'ouvrir le sélecteur de fichiers : ${String(e)}`, "error");
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    backend
      .onFileDrop((e) => {
        if (e.type === "over") setDragging(true);
        else if (e.type === "leave") setDragging(false);
        else {
          setDragging(false);
          const audio = e.paths.filter((p) => SOUND_EXTENSIONS.some((x) => p.toLowerCase().endsWith(`.${x}`)));
          if (audio.length < e.paths.length) notify("Seuls les fichiers mp3, wav, ogg et flac sont importés.", "error");
          void importPaths(audio);
        }
      })
      .then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

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
  const playingCount = Object.keys(progress).length;

  return (
    <div className={`bank${editedSound ? " bank--editing" : ""}`}>
      <div className="bank__main">
        <div className="bank__bar">
          <div className="bank__actions">
            <button type="button" className="btn btn--primary" onClick={pickAndImport}>
              <PixelIcon name="folder" scale={1} /> Importer des sons
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => call("stop_all_sounds", {})}
              disabled={playingCount === 0}
            >
              <PixelIcon name="stop" scale={1} /> Tout arrêter
            </button>
          </div>
          <div className="bank__levels">
            <Slider
              label="Vers le micro"
              hint="Ce que les autres entendent"
              value={settings.soundMicVolume}
              min={0}
              max={1}
              step={0.01}
              format={pct}
              onChange={(soundMicVolume) => patchSettings({ soundMicVolume })}
            />
            <Slider
              label="Dans mon casque"
              hint="Ce que tu entends"
              value={settings.soundMonitorVolume}
              min={0}
              max={1}
              step={0.01}
              format={pct}
              onChange={(soundMonitorVolume) => patchSettings({ soundMonitorVolume })}
            />
          </div>
        </div>
        <Chips label="Filtrer les sons" options={filterOptions} value={activeFilter} onChange={setFilter} />

        {sounds.length === 0 ? (
          <EmptyState
            icon="download"
            title="Ta banque est vide"
            action={
              <div className="row">
                <button type="button" className="btn btn--primary" onClick={pickAndImport}>Importer des sons</button>
                <button type="button" className="btn" onClick={onExplore}>Explorer MyInstants</button>
              </div>
            }
          >
            Glisse des fichiers mp3, wav, ogg ou flac ici, ou pioche dans les sons populaires.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon="favorite" title="Aucun son ici">
            Clique sur l'étoile d'un son pour le retrouver dans tes favoris.
          </EmptyState>
        ) : (
          <div className="pad-grid" role="list" onKeyDown={onGridKeyDown}>
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
          </div>
        )}
        <p className="hint bank__drop-hint">
          <PixelIcon name="download" scale={1} /> Glisse des fichiers audio n'importe où dans la fenêtre pour les importer.
        </p>
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

      {dragging ? (
        <div className="dropzone" aria-hidden="true">
          <PixelIcon name="download" scale={6} />
          <p>Lâche tes sons ici</p>
          <p className="hint">mp3 · wav · ogg · flac</p>
        </div>
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
    <div role="listitem" className={`pad${p ? " is-playing" : ""}${editing ? " is-editing" : ""}`}>
      <button
        type="button"
        data-grid-item
        className="pad__main"
        onClick={onToggle}
        aria-label={`${p ? "Arrêter" : "Jouer"} ${sound.name}`}
      >
        <span className="pad__glyph"><PixelIcon name={p ? "stop" : "play"} scale={2} /></span>
        <span className="pad__name">{sound.name}</span>
        <span className="pad__meta">
          <span>{sound.hotkey ?? "—"}</span>
          {sound.loop ? (
            <span className="pad__loop" title="Lecture en boucle">
              <PixelIcon name="loop" scale={1} /> boucle
            </span>
          ) : null}
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
      <span className="pad__progress" aria-hidden="true">
        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
    </div>
  );
}
