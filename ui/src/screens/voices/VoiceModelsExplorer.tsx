import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RemoteModel } from "../../ipc/contract";
import { errorMessage, useVox } from "../../state/store";
import { useDebounced } from "../../lib/useDebounced";
import { usePagedFeed, type FetchPage } from "../../lib/usePagedFeed";
import { PixelIcon } from "../../components/PixelIcon";
import { EmptyState, ErrorPanel, Field, ProgressBar, SearchField } from "../../components/Controls";
import { getRunning, setRunning, useRunningImport, type RunningImport } from "./aiImportRunning";
import { useAiPack } from "../../state/aiPack";

export const VOICE_MODELS_DEBOUNCE_MS = 300;
const NAME_MAX = 40;

/** Default voice name: the title without the site's technical tags ("[RVC v2]", "(300 epochs)"…). */
export function cleanModelTitle(title: string): string {
  const technical = /rvc|epoch|step|rmvpe|crepe|harvest|pm\b|v\d\b|\d+\s*k\b|google drive/i;
  const cleaned = title
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\(([^)]*)\)/g, (group, inner: string) => (technical.test(inner) ? " " : group))
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–_|]+|[\s\-–_|]+$/g, "");
  return (cleaned || title.trim()).slice(0, NAME_MAX).trim();
}

/** voice-models.com search with infinite scroll; "Ajouter" downloads, converts and registers a model. */
const modelKey = (m: RemoteModel) => m.downloadUrl;

export function VoiceModelsExplorer({ onImported }: { onImported: (voiceId: string | null) => void }) {
  const { backend, snapshot, setSnapshot, call, notify } = useVox();
  // An old pack (or none) cannot convert downloaded models: say so and offer the update first.
  const packReady = snapshot.aiPack.onlineReady;
  const [input, setInput] = useState("");
  const query = useDebounced(input.trim(), VOICE_MODELS_DEBOUNCE_MS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inFlight = useRunningImport();
  const fetchPage = useCallback<FetchPage<RemoteModel>>(
    async (q, page) => {
      const res = await backend.invoke("voicemodels_search", { query: q, page });
      return { items: res.models, hasMore: res.hasMore };
    },
    [backend],
  );
  // Pages can overlap: each model is listed once, by its download URL (as within a page).
  const { feed, loadNext, retry, sentinel } = usePagedFeed(query, fetchPage, { key: modelKey });
  // Closing the panel does not cancel a running download: its outcome then arrives as a toast.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  async function add(model: RemoteModel, name: string): Promise<boolean> {
    if (getRunning()) return false;
    const url = model.downloadUrl;
    setErrors((e) => {
      const next = { ...e };
      delete next[url];
      return next;
    });
    setRunning({ name, progress: 0, online: { url, stage: "download" } });
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await backend.listen("voicemodels-progress", ({ stage, progress }) =>
        setRunning({ name, progress, online: { url, stage } }),
      );
      const meta = await backend.invoke("voicemodels_add", { url, name });
      const snap = await call("get_snapshot", {});
      setSnapshot((s) => snap ?? { ...s, aiModels: [...s.aiModels, meta] });
      notify(`Voix IA « ${meta.name} » prête`);
      if (open.current) onImported(snap?.voices.find((v) => v.aiModelId === meta.id)?.id ?? null);
      return true;
    } catch (err) {
      const message = errorMessage(err);
      // Always a toast, like a success: the row may have left the results (new search) or the
      // explorer may be hidden (« Mes fichiers ») or closed. The row also shows it inline.
      if (open.current) setErrors((e) => ({ ...e, [url]: message }));
      notify(`Ajout de « ${name} » impossible : ${message}`, "error");
      return false;
    } finally {
      unlisten?.();
      setRunning(null);
    }
  }

  const initialLoading = feed.loading && feed.items.length === 0;

  return (
    <div className="vm">
      <p className="hint">
        Modèles RVC partagés sur voice-models.com. Ils appartiennent à leurs auteurs : respecte leurs conditions et les
        personnes dont ils imitent la voix. Seul le modèle (.pth) est importé : l'index d'une source inconnue n'est pas lu,
        par sécurité.
      </p>
      {packReady ? null : <PackNotice installed={snapshot.aiPack.installed} />}
      <SearchField label="Rechercher un modèle" placeholder="Rechercher un modèle" value={input} onChange={setInput} />
      {/* Outside the results: stays visible when the model being added leaves them (new search, reopened panel). */}
      {inFlight?.online ? <ActiveImport running={inFlight} stage={inFlight.online.stage} /> : null}
      {feed.error && feed.items.length === 0 ? (
        <ErrorPanel
          title="voice-models.com est injoignable"
          message={`Vérifie ta connexion internet : l'import depuis tes fichiers, lui, fonctionne hors ligne. Détail : ${feed.error}`}
          action={<button type="button" className="btn" onClick={retry}>Réessayer</button>}
        />
      ) : initialLoading ? (
        <p className="hint" role="status">Chargement des modèles<span className="blink">_</span></p>
      ) : feed.items.length === 0 && !feed.hasMore ? (
        <EmptyState
          icon="search"
          title={`Aucun modèle pour « ${feed.query} »`}
          action={<button type="button" className="btn" onClick={() => setInput("")}>Voir tous les modèles</button>}
        >
          Essaie un nom plus court, sans accents.
        </EmptyState>
      ) : (
        <>
          <ul className="vm-list" aria-label="Modèles voice-models.com">
            {feed.items.map((m, i) => (
              <ModelRow
                key={`${m.downloadUrl}-${i}`}
                model={m}
                running={inFlight?.online?.url === m.downloadUrl}
                locked={inFlight !== null || !packReady}
                error={errors[m.downloadUrl] ?? null}
                onAdd={(name) => add(m, name)}
              />
            ))}
          </ul>
          <div ref={sentinel} className="explorer__more">
            {feed.loading ? (
              <p className="hint" role="status">Chargement<span className="blink">_</span></p>
            ) : feed.error ? (
              <p className="field__error">
                {feed.error}{" "}
                <button type="button" className="btn btn--small" onClick={retry}>Réessayer</button>
              </p>
            ) : feed.hasMore ? (
              <button type="button" className="btn btn--ghost" onClick={loadNext}>Charger plus</button>
            ) : (
              <p className="hint">Fin des résultats.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Above the results while the installed pack cannot import downloaded models. */
function PackNotice({ installed }: { installed: boolean }) {
  const { phase, manual, offer } = useAiPack();
  return (
    <div className="vm-notice" role="status">
      <p>
        {installed
          ? "Le pack « Voix IA » installé est trop ancien pour ajouter des modèles en ligne."
          : "Installe le pack « Voix IA » pour ajouter des modèles en ligne."}
      </p>
      <button type="button" className="btn btn--small btn--primary" disabled={manual.kind === "checking" || phase.kind === "installing"} onClick={offer}>
        {manual.kind === "checking" ? "Recherche…" : installed ? "Mettre à jour le pack" : "Installer le pack"}
      </button>
      {manual.kind === "upToDate" ? <p className="hint">Aucun pack plus récent n’est encore publié : réessaie plus tard.</p> : null}
      {manual.kind === "failed" ? <p className="field__error">Recherche impossible : {manual.message}</p> : null}
    </div>
  );
}

function ModelRow({ model, running, locked, error, onAdd }: {
  model: RemoteModel;
  running: boolean;
  locked: boolean;
  error: string | null;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const id = useId();

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    const label = name.trim();
    if (!label) {
      setNameError("Donne un nom à cette voix IA.");
      return;
    }
    if (await onAdd(label)) setNaming(false);
  }

  return (
    <li className={`vm-row${naming ? " is-naming" : ""}`}>
      <div className="vm-row__head">
        <span className="vm-row__title">{model.title}</span>
        {model.size ? <span className="vm-row__size">{model.size}</span> : null}
        {running ? (
          <span className="vm-row__size">En cours…</span>
        ) : !naming ? (
          <button
            type="button"
            className="btn btn--small"
            disabled={locked}
            aria-label={`Ajouter ${model.title}`}
            onClick={() => {
              setName(cleanModelTitle(model.title));
              setNameError(null);
              setNaming(true);
            }}
          >
            <PixelIcon name="plus" scale={1} /> Ajouter
          </button>
        ) : null}
      </div>
      {running ? null : naming ? (
        <form className="vm-row__form" onSubmit={confirm} noValidate aria-label={`Nommer ${model.title}`}>
          <Field label="Nom de la voix" htmlFor={`${id}-name`} error={nameError}>
            <input
              id={`${id}-name`}
              className="input input--small"
              value={name}
              maxLength={NAME_MAX}
              autoComplete="off"
              aria-invalid={!!nameError}
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
                if (nameError && e.target.value.trim()) setNameError(null);
              }}
            />
          </Field>
          <div className="row">
            <button type="submit" className="btn btn--primary btn--small" disabled={locked}>Ajouter</button>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setNaming(false)}>Annuler</button>
          </div>
        </form>
      ) : null}
      {error ? <p className="field__error" role="alert">Ajout impossible : {error}</p> : null}
    </li>
  );
}

function ActiveImport({ running, stage }: { running: RunningImport; stage: "download" | "convert" }) {
  const label = stage === "convert" ? "Conversion du modèle" : "Téléchargement du modèle";
  return (
    <div className="stack stack--tight">
      <ProgressBar value={running.progress} label={label} />
      <p className="hint" role="status">
        « {running.name} » : {label.toLowerCase()}… {Math.round(running.progress * 100)} %
      </p>
    </div>
  );
}
