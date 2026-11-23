import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { errorMessage, useVox } from "../../state/store";
import { PixelIcon } from "../../components/PixelIcon";
import { ErrorPanel, Field, IconButton, ProgressBar } from "../../components/Controls";
import { SidePanel } from "../../components/SidePanel";

type ImportState = { kind: "idle" } | { kind: "error"; message: string };

/**
 * The import in flight, shared by every panel instance: progress events carry no id, so only one
 * conversion runs at a time, and a reopened panel shows that one instead of starting another.
 */
type Running = { name: string; progress: number };
let running: Running | null = null;
const subscribers = new Set<() => void>();
function setRunning(next: Running | null) {
  running = next;
  subscribers.forEach((notify) => notify());
}
const subscribe = (cb: () => void) => {
  subscribers.add(cb);
  return () => void subscribers.delete(cb);
};
const getRunning = () => running;

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Import an RVC v2 model (.pth + optional .index) as a new AI voice. */
export function AiImportPanel({ onClose, onImported }: { onClose: () => void; onImported: (voiceId: string | null) => void }) {
  const { backend, setSnapshot, call, notify } = useVox();
  const [pth, setPth] = useState<string | null>(null);
  const [index, setIndex] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [state, setState] = useState<ImportState>({ kind: "idle" });
  const inFlight = useSyncExternalStore(subscribe, getRunning);
  const id = useId();
  // Closing the panel does not cancel a running import: its outcome then arrives as a toast.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

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
    if (!pth || getRunning()) return;
    if (!name.trim()) {
      setNameError("Donne un nom à cette voix IA.");
      return;
    }
    const label = name.trim();
    setState({ kind: "idle" });
    setRunning({ name: label, progress: 0 });
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await backend.listen("ai-import-progress", ({ progress }) => setRunning({ name: label, progress }));
      const meta = await backend.invoke("import_ai_model", { pthPath: pth, indexPath: index, name: name.trim() });
      const snap = await call("get_snapshot", {});
      setSnapshot((s) => snap ?? { ...s, aiModels: [...s.aiModels, meta] });
      notify(`Voix IA « ${meta.name} » prête`);
      if (open.current) onImported(snap?.voices.find((v) => v.aiModelId === meta.id)?.id ?? null);
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
      if (!open.current) notify(`Import de « ${label} » impossible : ${errorMessage(err)}`, "error");
    } finally {
      unlisten?.();
      setRunning(null);
    }
  }

  const busy = inFlight !== null;
  return (
    <SidePanel title="Importer une voix IA" onClose={onClose}>
      <form className="panel-form" onSubmit={submit} noValidate aria-label="Importer une voix IA">
        <p className="hint">Un modèle RVC v2 (.pth), et son index (.index) si tu l'as : il améliore le timbre.</p>
        <div className="filepick">
          <span className="label">Modèle .pth</span>
          <div className="row">
            <button type="button" className="btn" onClick={() => pick("pth")} disabled={busy}>
              <PixelIcon name="folder" scale={1} /> {pth ? "Changer" : "Choisir le .pth"}
            </button>
            <span className="filepick__name">{pth ? fileName(pth) : "aucun fichier"}</span>
          </div>
        </div>
        <div className="filepick">
          <span className="label">Index .index (optionnel)</span>
          <div className="row">
            <button type="button" className="btn" onClick={() => pick("index")} disabled={busy || !pth}>
              <PixelIcon name="folder" scale={1} /> {index ? "Changer" : "Choisir l'index"}
            </button>
            <span className="filepick__name">{index ? fileName(index) : "aucun fichier"}</span>
            {index && !busy ? (
              <IconButton icon="close" size={1} label="Retirer l'index" onClick={() => setIndex(null)} />
            ) : null}
          </div>
        </div>
        <Field label="Nom de la voix" htmlFor={`${id}-name`} error={nameError}>
          <input
            id={`${id}-name`}
            className="input"
            value={name}
            maxLength={40}
            disabled={busy}
            autoComplete="off"
            aria-invalid={!!nameError}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError && e.target.value.trim()) setNameError(null);
            }}
          />
        </Field>
        {inFlight ? (
          <div className="stack stack--tight">
            <ProgressBar value={inFlight.progress} label="Conversion du modèle" />
            <p className="hint" role="status">
              Conversion de « {inFlight.name} » en ONNX… {Math.round(inFlight.progress * 100)} %
            </p>
          </div>
        ) : null}
        {state.kind === "error" ? <ErrorPanel title="Import impossible" message={state.message} /> : null}
        <div className="panel-actions">
          <button type="submit" className="btn btn--primary" disabled={!pth || busy}>
            {busy ? "Conversion…" : "Importer"}
          </button>
        </div>
      </form>
    </SidePanel>
  );
}
