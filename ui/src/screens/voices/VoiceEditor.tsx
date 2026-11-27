import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { EffectDescriptor, EffectSpec, VoicePreset } from "../../ipc/contract";
import { useVox } from "../../state/store";
import { clampParam, formatParam, newEffect, normalizeEffect } from "../../lib/params";
import { PixelIcon } from "../../components/PixelIcon";
import { VOICE_ICONS } from "../../components/icons";
import { Field, IconButton, Slider, Toggle } from "../../components/Controls";
import { SidePanel } from "../../components/SidePanel";
import { ColorSwatches } from "../../components/ColorSwatches";

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

/**
 * Side panel to create, duplicate, edit and delete a custom voice.
 * While open with live preview on, the engine plays the draft chain instead of the active voice.
 */
export function VoiceEditor({ voiceId, duplicateOf, onUnsavedChange, onClose, onDeleted }: {
  voiceId: string | null;
  duplicateOf: string | null;
  onUnsavedChange: (unsaved: boolean) => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { snapshot, setSnapshot, call, notify, selectVoice } = useVox();
  const catalog = snapshot.effectCatalog;

  const [initial] = useState<VoicePreset>(() => {
    const source = snapshot.voices.find((v) => v.id === (voiceId ?? duplicateOf));
    if (!source) return blank();
    if (source.builtin) return duplicate(source, catalog);
    return { ...source, effects: source.effects.map((e) => normalizeEffect(e, catalog)) };
  });
  const [draft, setDraft] = useState<VoicePreset>(initial);
  const saved = snapshot.voices.find((v) => v.id === draft.id && draft.id !== "");
  const dirty = !saved || JSON.stringify(saved) !== JSON.stringify(draft);
  // A new draft only holds work once it differs from what the panel opened with.
  const unsaved = saved ? dirty : JSON.stringify(draft) !== JSON.stringify(initial);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [livePreview, setLivePreview] = useState(true);
  const [iconsOpen, setIconsOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(draft.effects.length > 0 ? 0 : null);
  const id = useId();

  useEffect(() => {
    onUnsavedChange(unsaved);
  }, [unsaved, onUnsavedChange]);

  // Live preview: the backend overrides the active voice until we send null (on close / toggle off).
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

  const setEffect = (i: number, e: EffectSpec) =>
    setDraft((d) => ({ ...d, effects: d.effects.map((x, j) => (j === i ? e : x)) }));
  const move = (i: number, by: number) => {
    setDraft((d) => {
      const effects = [...d.effects];
      const [item] = effects.splice(i, 1);
      if (item) effects.splice(i + by, 0, item);
      return { ...d, effects };
    });
    if (expanded === i) setExpanded(i + by);
    else if (expanded === i + by) setExpanded(i);
  };
  const removeEffect = (i: number) => {
    setDraft((d) => ({ ...d, effects: d.effects.filter((_, j) => j !== i) }));
    setExpanded((x) => (x === null || x === i ? null : x > i ? x - 1 : x));
  };

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
    onDeleted();
  }

  async function use() {
    if (!saved) return;
    await selectVoice(saved.id);
  }

  const active = !!saved && snapshot.settings.activeVoiceId === saved.id;
  const title = saved ? "Modifier la voix" : duplicateOf ? "Dupliquer la voix" : "Nouvelle voix";

  return (
    <SidePanel title={title} onClose={onClose}>
      <form onSubmit={save} noValidate aria-label="Édition de la voix">
        {/* Locked while saving: the answer replaces the draft, so nothing typed meanwhile may be lost. */}
        <fieldset className="panel-form" disabled={saving}>
        <div className="identity">
          <button
            type="button"
            className="identity__icon"
            aria-expanded={iconsOpen}
            aria-controls={`${id}-icons`}
            aria-label="Changer d'icône"
            title="Changer d'icône"
            onClick={() => setIconsOpen((o) => !o)}
          >
            <PixelIcon name={draft.icon} scale={3} color={draft.color} />
          </button>
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
        </div>

        {iconsOpen ? (
          <div className="picker__grid" id={`${id}-icons`} role="radiogroup" aria-label="Icône">
            {VOICE_ICONS.map((name) => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={draft.icon === name}
                aria-label={name}
                className="picker__icon"
                onClick={() => {
                  setDraft({ ...draft, icon: name });
                  setIconsOpen(false);
                }}
              >
                <PixelIcon name={name} scale={2} color={draft.icon === name ? draft.color : undefined} />
              </button>
            ))}
          </div>
        ) : null}

        <ColorSwatches
          label="Couleur"
          options={VOICE_COLORS.includes(draft.color) ? VOICE_COLORS : [draft.color, ...VOICE_COLORS]}
          value={draft.color}
          onChange={(c) => c && setDraft({ ...draft, color: c })}
        />

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

        <div className="chain">
          <div className="section-head">
            <h3 className="section-title">Effets</h3>
            <Toggle compact label="Aperçu en direct" checked={livePreview} onChange={setLivePreview} />
          </div>
          <p className="hint">
            {livePreview
              ? "Tu entends ces effets en direct à la place de la voix active, tant que ce panneau est ouvert."
              : "Aperçu coupé : tu entends la voix active."}
          </p>
          {draft.effects.length === 0 ? (
            <p className="hint">Aucun effet : ta voix passe telle quelle.</p>
          ) : (
            <ol className="chain__list" aria-label="Effets de la voix">
              {draft.effects.map((e, i) => (
                <EffectRow
                  key={`${i}-${e.kind}`}
                  index={i}
                  count={draft.effects.length}
                  effect={e}
                  descriptor={catalog.find((d) => d.kind === e.kind)}
                  expanded={expanded === i}
                  onExpand={() => setExpanded(expanded === i ? null : i)}
                  onChange={(next) => setEffect(i, next)}
                  onMove={(by) => move(i, by)}
                  onRemove={() => removeEffect(i)}
                />
              ))}
            </ol>
          )}
          <AddEffect
            catalog={catalog}
            onAdd={(d) => {
              setDraft((v) => ({ ...v, effects: [...v.effects, newEffect(d)] }));
              setExpanded(draft.effects.length);
            }}
          />
        </div>

        <div className="panel-actions">
          <button type="submit" className="btn btn--primary" disabled={saving || (!dirty && !!saved)}>
            {saving ? "Enregistrement…" : saved ? "Enregistrer" : "Créer la voix"}
          </button>
          {saved ? (
            <button type="button" className="btn" onClick={use} disabled={active}>
              {active ? "Voix active" : "Utiliser"}
            </button>
          ) : null}
          {saved && dirty ? (
            <button type="button" className="btn btn--ghost" onClick={() => setDraft(saved)}>Annuler</button>
          ) : null}
        </div>
        {saved ? (
          <div className="danger-zone">
            {confirmDelete ? (
              <div className="row" role="group" aria-label="Confirmer la suppression">
                <span className="hint">Supprimer « {saved.name} » ?</span>
                <button type="button" className="btn btn--danger" onClick={remove}>Supprimer</button>
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>Garder</button>
              </div>
            ) : (
              <button type="button" className="link-btn link-btn--danger" onClick={() => setConfirmDelete(true)}>
                Supprimer cette voix
              </button>
            )}
          </div>
        ) : null}
        </fieldset>
      </form>
    </SidePanel>
  );
}

function EffectRow({ index, count, effect, descriptor, expanded, onExpand, onChange, onMove, onRemove }: {
  index: number;
  count: number;
  effect: EffectSpec;
  descriptor: EffectDescriptor | undefined;
  expanded: boolean;
  onExpand: () => void;
  onChange: (e: EffectSpec) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const label = descriptor?.label ?? effect.kind;
  const paramsId = useId();
  const hasParams = !!descriptor && descriptor.params.length > 0;
  return (
    <li className={`fx${effect.enabled ? "" : " is-off"}${expanded ? " is-open" : ""}`}>
      <div className="fx__head">
        <button
          type="button"
          className="fx__title"
          aria-expanded={hasParams ? expanded : undefined}
          aria-controls={hasParams ? paramsId : undefined}
          onClick={onExpand}
          disabled={!hasParams}
        >
          <span className="fx__num">{index + 1}</span>
          <span className="fx__label">{label}</span>
        </button>
        <Toggle compact label="Actif" checked={effect.enabled} onChange={(enabled) => onChange({ ...effect, enabled })} />
        <span className="fx__tools">
          <IconButton icon="up" size={1} label={`Monter ${label}`} disabled={index === 0} onClick={() => onMove(-1)} />
          <IconButton icon="down" size={1} label={`Descendre ${label}`} disabled={index === count - 1} onClick={() => onMove(1)} />
          <IconButton icon="trash" size={1} tone="danger" label={`Retirer ${label}`} onClick={onRemove} />
        </span>
      </div>
      {hasParams && expanded ? (
        <div className="fx__params" id={paramsId}>
          {descriptor.description ? <p className="hint">{descriptor.description}</p> : null}
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
      <label className="sr-only" htmlFor={id}>Effet à ajouter</label>
      <select
        id={id}
        className="input"
        value={kind}
        title={selected?.description}
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
  );
}
