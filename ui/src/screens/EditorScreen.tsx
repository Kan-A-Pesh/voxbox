import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { EffectDescriptor, EffectSpec, VoicePreset } from "../ipc/contract";
import { useVox } from "../state/store";
import { clampParam, formatParam, newEffect, normalizeEffect } from "../lib/params";
import { PixelIcon } from "../components/PixelIcon";
import { VOICE_ICONS } from "../components/icons";
import { Field, IconButton, Slider, Toggle } from "../components/Controls";

export const VOICE_COLORS = [
  "#b9a6ff", "#7fe7ff", "#ff9f1c", "#ff5d5d", "#5cf28a", "#b6f25c",
  "#ffd23f", "#ff8ad8", "#4fc3ff", "#a68a6d", "#f4efe2", "#9aa0b8",
];

export const PREVIEW_DEBOUNCE_MS = 150;

const blank = (): VoicePreset => ({
  id: "",
  name: "Nouvelle voix",
  description: "Ma voix",
  icon: "wrench",
  color: VOICE_COLORS[0] as string,
  category: "custom",
  effects: [],
  aiModelId: null,
  builtin: false,
});

function duplicate(v: VoicePreset, catalog: EffectDescriptor[]): VoicePreset {
  return {
    ...v,
    id: "",
    name: `${v.name} (copie)`,
    builtin: false,
    category: "custom",
    effects: v.effects.map((e) => normalizeEffect(e, catalog)),
  };
}

export function EditorScreen({ initialVoiceId }: { initialVoiceId: string | null }) {
  const { snapshot, setSnapshot, call, notify } = useVox();
  const catalog = snapshot.effectCatalog;
  const editable = snapshot.voices.filter((v) => !v.builtin && !v.aiModelId);
  const builtins = snapshot.voices.filter((v) => v.builtin && !v.aiModelId);

  const [draft, setDraft] = useState<VoicePreset>(() => {
    const target = snapshot.voices.find((v) => v.id === initialVoiceId);
    if (target?.builtin) return duplicate(target, catalog);
    const v = target ?? editable[0];
    return v ? { ...v, effects: v.effects.map((e) => normalizeEffect(e, catalog)) } : blank();
  });
  const saved = snapshot.voices.find((v) => v.id === draft.id && draft.id !== "");
  const dirty = !saved || JSON.stringify(saved) !== JSON.stringify(draft);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [livePreview, setLivePreview] = useState(true);
  const id = useId();

  // Live preview: the backend overrides the active voice until we send null (on leave / toggle off).
  const lastSent = useRef<string | null>(null);
  useEffect(() => {
    if (!livePreview) return;
    const payload = JSON.stringify(draft.effects);
    if (payload === lastSent.current) return;
    const t = setTimeout(() => {
      lastSent.current = payload;
      void call("preview_effects", { effects: draft.effects });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft.effects, livePreview, call]);
  useEffect(() => {
    if (livePreview) return;
    lastSent.current = null;
    void call("preview_effects", { effects: null });
  }, [livePreview, call]);
  const callRef = useRef(call);
  useEffect(() => {
    callRef.current = call;
  }, [call]);
  useEffect(() => () => void callRef.current("preview_effects", { effects: null }), []);

  function open(next: VoicePreset) {
    const unsaved = saved ? dirty : draft.effects.length > 0;
    if (unsaved && !window.confirm("Abandonner les modifications non enregistrées ?")) return;
    setDraft(next);
    setNameError(null);
    setConfirmDelete(false);
  }

  const setEffect = (i: number, e: EffectSpec) =>
    setDraft((d) => ({ ...d, effects: d.effects.map((x, j) => (j === i ? e : x)) }));
  const move = (i: number, by: number) =>
    setDraft((d) => {
      const effects = [...d.effects];
      const [item] = effects.splice(i, 1);
      if (item) effects.splice(i + by, 0, item);
      return { ...d, effects };
    });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setNameError("Donne un nom à ta voix.");
      return;
    }
    setSaving(true);
    const result = await call("save_voice", { voice: { ...draft, name, description: draft.description.trim() } });
    setSaving(false);
    if (!result) return;
    setSnapshot((s) => ({
      ...s,
      voices: s.voices.some((v) => v.id === result.id)
        ? s.voices.map((v) => (v.id === result.id ? result : v))
        : [...s.voices, result],
    }));
    setDraft(result);
    notify(`Voix « ${result.name} » enregistrée`);
  }

  async function remove() {
    if (!saved) return;
    const ok = await call("delete_voice", { id: saved.id });
    if (ok === undefined) return;
    const snap = await call("get_snapshot", {});
    setSnapshot((s) => snap ?? { ...s, voices: s.voices.filter((v) => v.id !== saved.id) });
    notify(`Voix « ${saved.name} » supprimée`);
    setDraft(blank());
    setConfirmDelete(false);
  }

  async function use() {
    if (!saved) return;
    const settings = await call("set_active_voice", { id: saved.id });
    if (settings) setSnapshot((s) => ({ ...s, settings }));
  }

  return (
    <section className="page" aria-labelledby="editor-title">
      <header className="page__head">
        <h1 className="page__title" id="editor-title">Éditeur</h1>
        <button type="button" className="btn" onClick={() => open(blank())}>
          <PixelIcon name="plus" scale={1} /> Nouvelle voix
        </button>
      </header>
      <div className="editor">
        <nav className="editor__list panel" aria-label="Voix modifiables">
          <h2 className="panel__title">Mes voix</h2>
          {editable.length === 0 ? (
            <p className="hint">Aucune voix perso pour l'instant.</p>
          ) : (
            <ul className="vlist">
              {editable.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    className="vlist__item"
                    aria-current={v.id === draft.id ? "true" : undefined}
                    onClick={() => open({ ...v, effects: v.effects.map((x) => normalizeEffect(x, catalog)) })}
                  >
                    <PixelIcon name={v.icon} scale={2} color={v.color} />
                    <span>{v.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h2 className="panel__title panel__title--spaced">Dupliquer</h2>
          <ul className="vlist vlist--scroll">
            {builtins.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className="vlist__item"
                  aria-label={`Dupliquer ${v.name}`}
                  onClick={() => open(duplicate(v, catalog))}
                >
                  <PixelIcon name={v.icon} scale={2} color={v.color} />
                  <span>{v.name}</span>
                  <PixelIcon name="copy" scale={1} className="vlist__trail" />
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <form className="editor__form" onSubmit={save} noValidate aria-label="Édition de la voix">
          <div className="panel editor__identity">
            <span className="editor__preview" style={{ borderColor: draft.color }}>
              <PixelIcon name={draft.icon} scale={5} color={draft.color} />
            </span>
            <div className="editor__fields">
              <Field label="Nom" htmlFor={`${id}-name`} error={nameError}>
                <input
                  id={`${id}-name`}
                  className="input"
                  value={draft.name}
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!nameError}
                  onChange={(e) => {
                    setDraft({ ...draft, name: e.target.value });
                    if (nameError && e.target.value.trim()) setNameError(null);
                  }}
                />
              </Field>
              <Field label="Description" htmlFor={`${id}-desc`}>
                <input
                  id={`${id}-desc`}
                  className="input"
                  value={draft.description}
                  maxLength={120}
                  autoComplete="off"
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </Field>
            </div>
            <fieldset className="picker">
              <legend className="label">Icône</legend>
              <div className="picker__grid" role="radiogroup" aria-label="Icône">
                {VOICE_ICONS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={draft.icon === name}
                    aria-label={name}
                    className="picker__icon"
                    onClick={() => setDraft({ ...draft, icon: name })}
                  >
                    <PixelIcon name={name} scale={2} color={draft.icon === name ? draft.color : undefined} />
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="picker">
              <legend className="label">Couleur</legend>
              <div className="picker__swatches" role="radiogroup" aria-label="Couleur">
                {(VOICE_COLORS.includes(draft.color) ? VOICE_COLORS : [draft.color, ...VOICE_COLORS]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={draft.color === c}
                    aria-label={c}
                    className="swatch"
                    style={{ background: c }}
                    onClick={() => setDraft({ ...draft, color: c })}
                  />
                ))}
              </div>
            </fieldset>
          </div>

          <div className="chain">
            <div className="chain__head">
              <h2 className="panel__title">Chaîne d'effets</h2>
              <Toggle compact label="Aperçu en direct" checked={livePreview} onChange={setLivePreview} />
            </div>
            <p className="hint">
              {livePreview
                ? "Tu entends cette chaîne en direct à la place de la voix active, tant que tu restes sur l'éditeur."
                : "Aperçu coupé : tu entends la voix active."}
            </p>
            {draft.effects.length === 0 ? (
              <p className="chain__empty">Aucun effet : ta voix passe telle quelle. Ajoute un premier effet ci-dessous.</p>
            ) : (
              <ol className="chain__list">
                {draft.effects.map((e, i) => (
                  <EffectRow
                    key={`${i}-${e.kind}`}
                    index={i}
                    count={draft.effects.length}
                    effect={e}
                    descriptor={catalog.find((d) => d.kind === e.kind)}
                    onChange={(next) => setEffect(i, next)}
                    onMove={(by) => move(i, by)}
                    onRemove={() => setDraft((d) => ({ ...d, effects: d.effects.filter((_, j) => j !== i) }))}
                  />
                ))}
              </ol>
            )}
            <AddEffect catalog={catalog} onAdd={(d) => setDraft((v) => ({ ...v, effects: [...v.effects, newEffect(d)] }))} />
          </div>

          <div className="editor__actions">
            <button type="submit" className="btn btn--primary" disabled={saving || (!dirty && !!saved)}>
              {saving ? "Enregistrement…" : saved ? "Enregistrer" : "Créer la voix"}
            </button>
            {saved ? (
              <button type="button" className="btn" onClick={use} disabled={snapshot.settings.activeVoiceId === saved.id}>
                {snapshot.settings.activeVoiceId === saved.id ? "Voix active" : "Utiliser cette voix"}
              </button>
            ) : null}
            {saved && dirty ? (
              <button type="button" className="btn btn--ghost" onClick={() => setDraft(saved)}>Annuler les modifications</button>
            ) : null}
            <span className="editor__spacer" />
            {saved ? (
              confirmDelete ? (
                <span className="row" role="group" aria-label="Confirmer la suppression">
                  <span className="hint">Supprimer « {saved.name} » ?</span>
                  <button type="button" className="btn btn--danger" onClick={remove}>Supprimer</button>
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>Garder</button>
                </span>
              ) : (
                <button type="button" className="btn btn--ghost btn--danger-text" onClick={() => setConfirmDelete(true)}>
                  <PixelIcon name="trash" scale={1} /> Supprimer
                </button>
              )
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}

function EffectRow({ index, count, effect, descriptor, onChange, onMove, onRemove }: {
  index: number;
  count: number;
  effect: EffectSpec;
  descriptor: EffectDescriptor | undefined;
  onChange: (e: EffectSpec) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const label = descriptor?.label ?? effect.kind;
  return (
    <li className={`fx${effect.enabled ? "" : " is-off"}`}>
      <div className="fx__head">
        <span className="fx__num">{String(index + 1).padStart(2, "0")}</span>
        <span className="fx__title">
          <span className="fx__label">{label}</span>
          {descriptor ? <span className="fx__desc">{descriptor.description}</span> : null}
        </span>
        <Toggle compact label="Actif" checked={effect.enabled} onChange={(enabled) => onChange({ ...effect, enabled })} />
        <IconButton icon="up" size={1} label={`Monter ${label}`} disabled={index === 0} onClick={() => onMove(-1)} />
        <IconButton icon="down" size={1} label={`Descendre ${label}`} disabled={index === count - 1} onClick={() => onMove(1)} />
        <IconButton icon="trash" size={1} tone="danger" label={`Retirer ${label}`} onClick={onRemove} />
      </div>
      {descriptor && descriptor.params.length > 0 ? (
        <div className="fx__params">
          {descriptor.params.map((p) => (
            <Slider
              key={p.key}
              label={p.label}
              value={effect.params[p.key] ?? p.default}
              min={p.min}
              max={p.max}
              step={p.step}
              format={(v) => formatParam(v, p)}
              onChange={(v) => onChange({ ...effect, params: { ...effect.params, [p.key]: clampParam(v, p) } })}
            />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function AddEffect({ catalog, onAdd }: { catalog: EffectDescriptor[]; onAdd: (d: EffectDescriptor) => void }) {
  const [kind, setKind] = useState(catalog[0]?.kind ?? "pitchShift");
  const id = useId();
  const selected = useMemo(() => catalog.find((d) => d.kind === kind), [catalog, kind]);
  return (
    <div className="add-fx">
      <label className="label" htmlFor={id}>Ajouter un effet</label>
      <div className="row">
        <select
          id={id}
          className="input"
          value={kind}
          onChange={(e) => {
            const d = catalog.find((x) => x.kind === e.target.value);
            if (d) setKind(d.kind);
          }}
        >
          {catalog.map((d) => <option key={d.kind} value={d.kind}>{d.label}</option>)}
        </select>
        <button type="button" className="btn" onClick={() => selected && onAdd(selected)} disabled={!selected}>
          <PixelIcon name="plus" scale={1} /> Ajouter
        </button>
      </div>
      {selected ? <p className="hint">{selected.description}</p> : null}
    </div>
  );
}
