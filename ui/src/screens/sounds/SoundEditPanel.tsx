import { useId, useState } from "react";
import type { Sound } from "../../ipc/contract";
import { useVox } from "../../state/store";
import { conflictFor, describeAction } from "../../lib/hotkeys";
import { Field, IconButton, Slider, Toggle } from "../../components/Controls";
import { HotkeyCapture } from "../../components/HotkeyCapture";

const formatDuration = (ms: number) => {
  const s = Math.round(ms / 100) / 10;
  return s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toLocaleString("fr-FR")} s`;
};

export function SoundEditPanel({ sound, categories, onSave, onDelete, onClose }: {
  sound: Sound;
  categories: string[];
  onSave: (s: Sound) => Promise<boolean>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { snapshot } = useVox();
  const [draft, setDraft] = useState(sound);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const id = useId();
  const dirty = JSON.stringify(draft) !== JSON.stringify(sound);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setNameError("Donne un nom à ce son.");
      return;
    }
    setSaving(true);
    await onSave({ ...draft, name, category: draft.category?.trim() || null });
    setSaving(false);
  }

  return (
    <aside className="panel edit-panel" aria-labelledby={`${id}-title`}>
      <div className="panel__head">
        <h2 className="panel__title" id={`${id}-title`}>Modifier le son</h2>
        <IconButton icon="close" size={1} label="Fermer le panneau" onClick={onClose} />
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Nom" htmlFor={`${id}-name`} error={nameError}>
          <input
            id={`${id}-name`}
            className="input"
            value={draft.name}
            maxLength={60}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!!nameError}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              if (nameError && e.target.value.trim()) setNameError(null);
            }}
          />
        </Field>
        <Field label="Catégorie" htmlFor={`${id}-cat`} hint="Choisis-en une ou tape un nouveau nom.">
          <input
            id={`${id}-cat`}
            className="input"
            list={`${id}-cats`}
            value={draft.category ?? ""}
            placeholder="Sans catégorie"
            autoComplete="off"
            onChange={(e) => setDraft({ ...draft, category: e.target.value || null })}
          />
          <datalist id={`${id}-cats`}>
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </Field>
        <Slider
          label="Volume"
          value={draft.volume}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)} %`}
          onChange={(volume) => setDraft({ ...draft, volume })}
        />
        <Toggle
          label="Lecture en boucle"
          hint="Rejoue le son jusqu'à ce que tu l'arrêtes."
          checked={draft.loop}
          onChange={(loop) => setDraft({ ...draft, loop })}
        />
        <div className="field">
          <span className="label" id={`${id}-hk`}>Raccourci</span>
          <HotkeyCapture
            label={`Raccourci pour ${sound.name}`}
            value={draft.hotkey}
            onChange={(hotkey) => setDraft({ ...draft, hotkey })}
            conflict={(acc) => {
              const c = conflictFor(snapshot.hotkeys, { type: "sound", id: sound.id }, acc);
              return c ? `Déjà utilisé par ${describeAction(c.action, snapshot)} : il sera réassigné.` : null;
            }}
          />
        </div>
        <dl className="meta-list">
          <dt>Durée</dt>
          <dd>{formatDuration(sound.durationMs)}</dd>
          <dt>Source</dt>
          <dd>{sound.source === "myinstants" ? "MyInstants" : "Fichier local"}</dd>
        </dl>
        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
          <button type="button" className="btn btn--ghost" disabled={!dirty || saving} onClick={() => setDraft(sound)}>
            Annuler
          </button>
        </div>
      </form>
      <div className="danger-zone">
        {confirmDelete ? (
          <div className="row" role="group" aria-label="Confirmer la suppression">
            <span className="hint">Supprimer « {sound.name} » ?</span>
            <button type="button" className="btn btn--danger" onClick={onDelete}>Supprimer</button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>Garder</button>
          </div>
        ) : (
          <button type="button" className="btn btn--ghost btn--danger-text" onClick={() => setConfirmDelete(true)}>
            Supprimer ce son
          </button>
        )}
      </div>
    </aside>
  );
}
