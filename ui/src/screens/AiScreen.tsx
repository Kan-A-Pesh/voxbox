import { useEffect, useId, useState } from "react";
import type { AiBackend, AiModelMeta, RvcParams } from "../ipc/contract";
import { errorMessage, useVox } from "../state/store";
import { PixelIcon } from "../components/PixelIcon";
import { EmptyState, ErrorPanel, Field, ProgressBar, Slider } from "../components/Controls";
import { RVC_LIMITS, clampRvcParams, maxCrossfadeMs, sameRvcParams } from "../lib/rvcParams";

const BACKEND_LABEL: Record<AiBackend, string> = { cuda: "CUDA", directMl: "DirectML", cpu: "CPU" };
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function AiScreen() {
  const { snapshot, setSnapshot, call, patchSettings, notify } = useVox();
  const { aiBackend, aiModels, settings } = snapshot;
  const [params, setParams] = useState<RvcParams>(settings.aiParams);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Sliders move locally; the engine gets the new params once the hand stops (RVC reloads its stream on change).
  // What the backend accepted is shown back, so the screen never displays a value that is not in use.
  const [accepted, setAccepted] = useState<RvcParams>(settings.aiParams);
  if (!sameRvcParams(accepted, settings.aiParams)) {
    setAccepted(settings.aiParams);
    setParams(settings.aiParams);
  }
  useEffect(() => {
    if (sameRvcParams(params, settings.aiParams)) return;
    const t = setTimeout(() => void patchSettings({ aiParams: clampRvcParams(params) }), 250);
    return () => clearTimeout(t);
  }, [params, settings.aiParams, patchSettings]);

  const voiceFor = (m: AiModelMeta) => snapshot.voices.find((v) => v.aiModelId === m.id);

  async function use(m: AiModelMeta) {
    const v = voiceFor(m);
    if (!v) return;
    const s = await call("set_active_voice", { id: v.id });
    if (s) setSnapshot((snap) => ({ ...snap, settings: s }));
  }

  async function remove(m: AiModelMeta) {
    const ok = await call("delete_ai_model", { id: m.id });
    setConfirmDelete(null);
    if (ok === undefined) return;
    const snap = await call("get_snapshot", {});
    setSnapshot((s) => snap ?? { ...s, aiModels: s.aiModels.filter((x) => x.id !== m.id) });
    notify(`Modèle « ${m.name} » supprimé`);
  }

  return (
    <section className="page" aria-labelledby="ai-title">
      <header className="page__head">
        <h1 className="page__title" id="ai-title">Voix IA</h1>
      </header>

      <div className="ai">
        <div className="ai__col">
          <div className={`panel backend${aiBackend.backend === "cpu" ? " backend--cpu" : ""}`}>
            <span className="tag tag--ai">{BACKEND_LABEL[aiBackend.backend]}</span>
            <div>
              <p className="backend__device">{aiBackend.deviceName}</p>
              <p className="hint">
                {aiBackend.backend === "cpu"
                  ? "Aucun GPU compatible : la conversion IA tourne sur le processeur, attends-toi à beaucoup de latence."
                  : "Conversion RVC accélérée par ta carte graphique, 100 % en local."}
              </p>
            </div>
          </div>

          <div className="panel">
            <h2 className="panel__title">Modèles</h2>
            {aiModels.length === 0 ? (
              <EmptyState icon="mic" title="Aucun modèle IA">Importe un modèle RVC (.pth) pour créer ta première voix IA.</EmptyState>
            ) : (
              <ul className="models">
                {aiModels.map((m) => {
                  const v = voiceFor(m);
                  const active = v?.id === settings.activeVoiceId;
                  return (
                    <li key={m.id} className={`model${active ? " is-active" : ""}`}>
                      <PixelIcon name={v?.icon ?? "mic"} scale={3} color={v?.color ?? "var(--cyan)"} />
                      <div className="model__body">
                        <p className="model__name">
                          {m.name}
                          {m.builtin ? <span className="tag tag--muted">Fourni</span> : null}
                          {active ? <span className="tag tag--active">Active</span> : null}
                        </p>
                        <p className="model__meta">
                          {(m.modelSampleRate / 1000).toLocaleString("fr-FR")} kHz · {m.hasIndex ? "avec index" : "sans index"}
                        </p>
                        {m.license ? <p className="model__meta">Licence : {m.license}</p> : null}
                      </div>
                      <div className="row">
                        <button type="button" className="btn btn--small" disabled={!v || active} onClick={() => use(m)}>
                          {active ? "Utilisée" : "Utiliser"}
                        </button>
                        {!m.builtin ? (
                          confirmDelete === m.id ? (
                            <>
                              <button type="button" className="btn btn--danger btn--small" onClick={() => remove(m)}>Confirmer</button>
                              <button type="button" className="btn btn--ghost btn--small" onClick={() => setConfirmDelete(null)}>Garder</button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="icon-btn icon-btn--danger"
                              aria-label={`Supprimer ${m.name}`}
                              title="Supprimer"
                              onClick={() => setConfirmDelete(m.id)}
                            >
                              <PixelIcon name="trash" scale={1} />
                            </button>
                          )
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="ai__col">
          <ImportModel />
          <div className="panel stack">
            <h2 className="panel__title">Réglages RVC</h2>
            <Slider
              label="Hauteur"
              value={params.pitchSemitones}
              {...RVC_LIMITS.pitchSemitones}
              format={(v) => `${v > 0 ? "+" : ""}${v} dt`}
              hint="+12 pour passer d'une voix d'homme à une voix de femme, -12 pour l'inverse."
              onChange={(pitchSemitones) => setParams((p) => ({ ...p, pitchSemitones }))}
            />
            <Slider
              label="Taux d'index"
              value={params.indexRate}
              {...RVC_LIMITS.indexRate}
              format={(v) => `${Math.round(v * 100)} %`}
              hint="Plus haut : timbre plus fidèle au modèle, articulation parfois moins nette."
              onChange={(indexRate) => setParams((p) => ({ ...p, indexRate }))}
            />
            <Slider
              label="Taille de bloc"
              value={params.blockMs}
              {...RVC_LIMITS.blockMs}
              format={(v) => `${v} ms`}
              hint="Bloc court = moins de latence, mais risque de craquements si le GPU ne suit pas."
              onChange={(blockMs) => setParams((p) => clampRvcParams({ ...p, blockMs }))}
            />
            <Slider
              label="Fondu entre blocs"
              value={params.crossfadeMs}
              min={RVC_LIMITS.crossfadeMs.min}
              max={maxCrossfadeMs(params.blockMs)}
              step={RVC_LIMITS.crossfadeMs.step}
              format={(v) => `${v} ms`}
              onChange={(crossfadeMs) => setParams((p) => ({ ...p, crossfadeMs }))}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

type ImportState = { kind: "idle" } | { kind: "running"; progress: number } | { kind: "error"; message: string };

function ImportModel() {
  const { backend, setSnapshot, call, notify } = useVox();
  const [pth, setPth] = useState<string | null>(null);
  const [index, setIndex] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [state, setState] = useState<ImportState>({ kind: "idle" });
  const id = useId();

  async function pick(kind: "pth" | "index") {
    try {
      const files = await backend.pickFiles({
        title: kind === "pth" ? "Modèle RVC (.pth)" : "Index RVC (.index)",
        extensions: [kind],
        multiple: false,
      });
      const file = files?.[0];
      if (!file) return;
      if (kind === "pth") {
        setPth(file);
        if (!name) setName(fileName(file).replace(/\.pth$/i, "").replace(/[-_]+/g, " "));
      } else setIndex(file);
      if (state.kind === "error") setState({ kind: "idle" });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pth) return;
    if (!name.trim()) {
      setNameError("Donne un nom à cette voix IA.");
      return;
    }
    setState({ kind: "running", progress: 0 });
    const unlisten = await backend.listen("ai-import-progress", ({ progress }) =>
      setState((s) => (s.kind === "running" ? { kind: "running", progress } : s)),
    );
    try {
      const meta = await backend.invoke("import_ai_model", { pthPath: pth, indexPath: index, name: name.trim() });
      const snap = await call("get_snapshot", {});
      setSnapshot((s) => snap ?? { ...s, aiModels: [...s.aiModels, meta] });
      notify(`Voix IA « ${meta.name} » prête`);
      setPth(null);
      setIndex(null);
      setName("");
      setState({ kind: "idle" });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    } finally {
      unlisten();
    }
  }

  const running = state.kind === "running";
  return (
    <form className="panel stack" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <h2 className="panel__title" id={`${id}-title`}>Importer un modèle</h2>
      <p className="hint">Un modèle RVC v2 (.pth), et son index (.index) si tu l'as : il améliore le timbre.</p>
      <div className="filepick">
        <span className="label">Modèle .pth</span>
        <div className="row">
          <button type="button" className="btn" onClick={() => pick("pth")} disabled={running}>
            <PixelIcon name="folder" scale={1} /> {pth ? "Changer" : "Choisir le .pth"}
          </button>
          <span className="filepick__name">{pth ? fileName(pth) : "aucun fichier"}</span>
        </div>
      </div>
      <div className="filepick">
        <span className="label">Index .index (optionnel)</span>
        <div className="row">
          <button type="button" className="btn" onClick={() => pick("index")} disabled={running || !pth}>
            <PixelIcon name="folder" scale={1} /> {index ? "Changer" : "Choisir l'index"}
          </button>
          <span className="filepick__name">{index ? fileName(index) : "aucun fichier"}</span>
          {index && !running ? (
            <button type="button" className="icon-btn icon-btn--flat" aria-label="Retirer l'index" onClick={() => setIndex(null)}>
              <PixelIcon name="close" scale={1} />
            </button>
          ) : null}
        </div>
      </div>
      <Field label="Nom de la voix" htmlFor={`${id}-name`} error={nameError}>
        <input
          id={`${id}-name`}
          className="input"
          value={name}
          maxLength={40}
          disabled={running}
          autoComplete="off"
          aria-invalid={!!nameError}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError && e.target.value.trim()) setNameError(null);
          }}
        />
      </Field>
      {running ? (
        <div className="stack stack--tight">
          <ProgressBar value={state.progress} label="Conversion du modèle" />
          <p className="hint" role="status">Conversion en ONNX… {Math.round(state.progress * 100)} %</p>
        </div>
      ) : null}
      {state.kind === "error" ? <ErrorPanel title="Import impossible" message={state.message} /> : null}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={!pth || running}>
          {running ? "Conversion…" : "Importer"}
        </button>
      </div>
    </form>
  );
}
