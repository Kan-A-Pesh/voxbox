import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RemoteSound } from "../../ipc/contract";
import { errorMessage, useVox } from "../../state/store";
import { useDebounced } from "../../lib/useDebounced";
import { onGridKeyDown } from "../../lib/gridNav";
import { PixelIcon } from "../../components/PixelIcon";
import { EmptyState, ErrorPanel, SearchField } from "../../components/Controls";

export const SEARCH_DEBOUNCE_MS = 300;

type Feed = {
  query: string;
  sounds: RemoteSound[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
};

export function Explorer() {
  const { backend, snapshot, setSnapshot, call, notify } = useVox();
  const [input, setInput] = useState("");
  const query = useDebounced(input.trim(), SEARCH_DEBOUNCE_MS);
  const [feed, setFeed] = useState<Feed>({ query, sounds: [], page: 0, hasMore: true, loading: true, error: null });
  const request = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const load = useCallback(
    async (q: string, page: number) => {
      const id = ++request.current;
      setFeed((f) => ({ ...(page === 1 ? { query: q, sounds: [], page: 0, hasMore: true } : f), loading: true, error: null }));
      try {
        const res = q
          ? await backend.invoke("myinstants_search", { query: q, page })
          : await backend.invoke("myinstants_trending", { page });
        if (id !== request.current) return;
        setFeed((f) => ({
          query: q,
          sounds: page === 1 ? res.sounds : [...f.sounds, ...res.sounds],
          page,
          hasMore: res.hasMore,
          loading: false,
          error: null,
        }));
      } catch (e) {
        if (id !== request.current) return;
        setFeed((f) => ({ ...f, loading: false, error: errorMessage(e) }));
      }
    },
    [backend],
  );

  useEffect(() => {
    void load(query, 1);
  }, [query, load]);

  // Infinite scroll stops on an error; only the explicit "Réessayer" retries the failed page.
  const loadMore = useCallback(() => {
    if (!feed.loading && feed.hasMore && !feed.error) void load(feed.query, feed.page + 1);
  }, [feed, load]);
  const retry = useCallback(() => {
    if (!feed.loading) void load(feed.query, feed.page + 1);
  }, [feed, load]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), {
      rootMargin: "300px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  useEffect(() => () => audio.current?.pause(), []);

  function preview(s: RemoteSound) {
    const el = audio.current;
    if (!el) return;
    setPreviewError(null);
    if (previewing === s.mp3Url) {
      el.pause();
      setPreviewing(null);
      return;
    }
    el.src = s.mp3Url;
    el.currentTime = 0;
    setPreviewing(s.mp3Url);
    el.play().catch(() => {
      setPreviewing(null);
      setPreviewError(`Aperçu impossible pour « ${s.title} ».`);
    });
  }

  const inBank = useMemo(
    () => new Set(snapshot.sounds.map((s) => s.sourceUrl).filter(Boolean) as string[]),
    [snapshot.sounds],
  );
  const categories = useMemo(
    () => [...new Set(snapshot.sounds.map((s) => s.category).filter((c): c is string => !!c))].sort(),
    [snapshot.sounds],
  );

  async function add(s: RemoteSound, category: string | null) {
    const added = await call("myinstants_add", { sound: s, category });
    if (!added) return false;
    setSnapshot((snap) => ({ ...snap, sounds: [...snap.sounds, added] }));
    notify(`« ${added.name} » ajouté à ta banque${category ? ` (${category})` : ""}`);
    return true;
  }

  const initialLoading = feed.loading && feed.sounds.length === 0;

  return (
    <div className="explorer">
      <div className="explorer__bar">
        <SearchField label="Rechercher sur MyInstants" placeholder="chercher un son_" value={input} onChange={setInput} />
        <p className="hint">
          {query ? `Résultats pour « ${query} »` : "Sons populaires sur MyInstants"} · seule fonction en ligne de VoxBox
        </p>
      </div>
      <audio
        ref={audio}
        preload="none"
        onEnded={() => setPreviewing(null)}
        onError={() => {
          if (previewing) setPreviewError("Aperçu indisponible : vérifie ta connexion.");
          setPreviewing(null);
        }}
      />
      {previewError ? <p className="field__error" role="alert">{previewError}</p> : null}

      {feed.error && feed.sounds.length === 0 ? (
        <ErrorPanel
          title="MyInstants est injoignable"
          message={`Vérifie ta connexion internet : ta banque locale, elle, fonctionne hors ligne. Détail : ${feed.error}`}
          action={<button type="button" className="btn" onClick={() => load(feed.query, 1)}>Réessayer</button>}
        />
      ) : initialLoading ? (
        <div className="remote-grid" aria-busy="true" aria-label="Chargement des sons">
          {Array.from({ length: 12 }, (_, i) => <div key={i} className="remote remote--skeleton" />)}
        </div>
      ) : feed.sounds.length === 0 ? (
        <EmptyState
          icon="search"
          title={`Aucun son pour « ${feed.query} »`}
          action={<button type="button" className="btn" onClick={() => setInput("")}>Voir les sons populaires</button>}
        >
          Essaie un mot plus court ou en anglais.
        </EmptyState>
      ) : (
        <>
          <div className="remote-grid" role="list" onKeyDown={onGridKeyDown}>
            {feed.sounds.map((s, i) => (
              <RemoteTile
                key={`${s.pageUrl}-${i}`}
                sound={s}
                seed={i}
                playing={previewing === s.mp3Url}
                added={inBank.has(s.pageUrl)}
                categories={categories}
                onPreview={() => preview(s)}
                onAdd={(c) => add(s, c)}
              />
            ))}
          </div>
          <div ref={sentinel} className="explorer__more">
            {feed.loading ? (
              <p className="hint" role="status">Chargement<span className="blink">_</span></p>
            ) : feed.error ? (
              <p className="field__error">
                {feed.error}{" "}
                <button type="button" className="btn btn--small" onClick={retry}>Réessayer</button>
              </p>
            ) : feed.hasMore ? (
              <button type="button" className="btn btn--ghost" onClick={loadMore}>Charger plus</button>
            ) : (
              <p className="hint">Fin des résultats.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const TILE_COLORS = ["#b9a6ff", "#7fe7ff", "#ff9f1c", "#5cf28a", "#ff8ad8", "#ffd23f", "#ff5d5d"];
const NEW = "__new";

function RemoteTile({ sound, seed, playing, added, categories, onPreview, onAdd }: {
  sound: RemoteSound;
  seed: number;
  playing: boolean;
  added: boolean;
  categories: string[];
  onPreview: () => void;
  onAdd: (category: string | null) => Promise<boolean>;
}) {
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState<string>("");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const color = TILE_COLORS[seed % TILE_COLORS.length];

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    const category = choice === NEW ? custom.trim() || null : choice || null;
    setBusy(true);
    const ok = await onAdd(category);
    setBusy(false);
    if (ok) setPicking(false);
  }

  return (
    <div role="listitem" className={`remote${playing ? " is-playing" : ""}`} style={{ "--tile": color } as React.CSSProperties}>
      <button
        type="button"
        data-grid-item
        className="remote__play"
        onClick={onPreview}
        aria-label={`${playing ? "Arrêter l'aperçu de" : "Écouter"} ${sound.title}`}
      >
        <span className="remote__disc"><PixelIcon name={playing ? "stop" : "play"} scale={2} /></span>
        <span className="remote__title">{sound.title}</span>
      </button>
      {picking ? (
        <form className="remote__pick" onSubmit={confirm}>
          <label className="label" htmlFor={`${id}-cat`}>Catégorie</label>
          <select id={`${id}-cat`} className="input input--small" value={choice} onChange={(e) => setChoice(e.target.value)} autoFocus>
            <option value="">Sans catégorie</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value={NEW}>Nouvelle catégorie…</option>
          </select>
          {choice === NEW ? (
            <input
              className="input input--small"
              aria-label="Nom de la nouvelle catégorie"
              placeholder="ex. Mèmes"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              autoFocus
            />
          ) : null}
          <div className="row">
            <button type="submit" className="btn btn--primary btn--small" disabled={busy}>{busy ? "Ajout…" : "Ajouter"}</button>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setPicking(false)}>Annuler</button>
          </div>
        </form>
      ) : (
        <div className="remote__foot">
          {added ? (
            <span className="remote__added"><PixelIcon name="check" scale={1} /> Dans ta banque</span>
          ) : (
            <button type="button" className="btn btn--small" onClick={() => setPicking(true)}>
              <PixelIcon name="plus" scale={1} /> Ajouter
            </button>
          )}
        </div>
      )}
    </div>
  );
}
