import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RemoteSound } from "../../ipc/contract";
import { useVox } from "../../state/store";
import { useDebounced } from "../../lib/useDebounced";
import { sendSoundCommand } from "../../lib/soundCommands";
import { MAX_EMPTY_AUTO_PAGES, usePagedFeed, type FetchPage } from "../../lib/usePagedFeed";
import { onGridKeyDown } from "../../lib/gridNav";
import { PixelIcon } from "../../components/PixelIcon";
import { EmptyState, ErrorPanel, IconButton } from "../../components/Controls";

export const SEARCH_DEBOUNCE_MS = 300;

export function Explorer({ query: input, onClearQuery, onPendingChange }: {
  query: string;
  onClearQuery: () => void;
  /** How many of its sounds play or download (« Tout arrêter » stops or cancels them). */
  onPendingChange?: (pending: number) => void;
}) {
  const { backend, snapshot, setSnapshot, call, soundCall, notify } = useVox();
  const query = useDebounced(input.trim(), SEARCH_DEBOUNCE_MS);
  const fetchPage = useCallback<FetchPage<RemoteSound>>(
    async (q, page) => {
      const res = q
        ? await backend.invoke("myinstants_search", { query: q, page })
        : await backend.invoke("myinstants_trending", { page });
      return { items: res.sounds, hasMore: res.hasMore };
    },
    [backend],
  );
  // Pages can overlap (the site's lists move): each sound is kept once, by its mp3.
  const { feed, loadNext, retry, sentinel } = usePagedFeed(query, fetchPage, {
    key: soundKey,
    logContext: "MyInstants (page suivante)",
  });
  // The last playback of each MyInstants sound (its id and whether it went to
  // everyone or the headset only), and the ones still downloading.
  const [playback, setPlayback] = useState<Record<string, { id: string; mode: Mode }>>({});
  const [starting, setStarting] = useState<Set<string>>(() => new Set());
  // Taken synchronously on the first click, so a second click during the switch is ignored.
  const busy = useRef(new Set<string>());
  // Sounds of this screen that "Tout arrêter" can stop, downloading ones included.
  useEffect(() => onPendingChange?.(starting.size + Object.keys(playback).length), [starting, playback, onPendingChange]);

  // A playback counts from its confirmed start until the engine says it ended,
  // whether or not a progress event arrived yet.
  const playingMode = (sound: RemoteSound): Mode | null => playback[sound.mp3Url]?.mode ?? null;
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    backend
      .listen("engine", (e) => {
        if (e.type !== "soundEnded") return;
        if (!started.current.delete(e.id)) {
          // Ended before its play command answered (stopped at once, or no free voice):
          // kept only while that sound's request is pending.
          const url = remoteUrlOf(e.id);
          if (url !== null && pending.current.has(url)) endedEarly.current.add(e.id);
          return;
        }
        setPlayback((p) => {
          const url = Object.keys(p).find((k) => p[k]?.id === e.id);
          if (!url) return p;
          const next = { ...p };
          delete next[url];
          return next;
        });
      })
      .then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [backend]);

  // Every playback this screen started, stopped when leaving it. A request still
  // downloading when the screen goes away stops its sound as soon as it starts.
  const started = useRef(new Set<string>());
  const endedEarly = useRef(new Set<string>());
  // Sounds whose play request still waits for its answer.
  const pending = useRef(new Set<string>());
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    const ids = started.current;
    return () => {
      gone.current = true;
      // Stopping a play still downloading cancels it: it never starts.
      ids.forEach((id) => void sendSoundCommand(backend, (page) => backend.invoke("stop_sound", { id, page })).catch(() => undefined));
      ids.clear();
    };
  }, [backend]);

  async function listen(s: RemoteSound, mode: Mode) {
    const url = s.mp3Url;
    if (busy.current.has(url)) return;
    busy.current.add(url);
    pending.current.add(url);
    setStarting((set) => new Set(set).add(url));
    try {
      const mine = playback[url];
      const forget = () =>
        setPlayback((p) => {
          if (p[url]?.id !== mine?.id) return p;
          const next = { ...p };
          delete next[url];
          return next;
        });
      if (mine?.mode === mode) {
        await soundCall((b, page) => b.invoke("stop_sound", { id: mine.id, page }));
        forget();
        return;
      }
      // Switching mode: the app stops the old playback and starts the new one in one
      // request, so a "Tout arrêter" clicked meanwhile cancels both.
      if (mine) forget();
      const id = await soundCall((b, page, stops) =>
        b.invoke("myinstants_play", { sound: s, preview: mode === "preview", replace: mine?.id ?? null, page, stops }),
      );
      if (gone.current) {
        if (id) void sendSoundCommand(backend, (page) => backend.invoke("stop_sound", { id, page })).catch(() => undefined);
        return;
      }
      if (!id || endedEarly.current.delete(id)) return;
      started.current.add(id);
      setPlayback((p) => ({ ...p, [url]: { id, mode } }));
    } finally {
      busy.current.delete(url);
      pending.current.delete(url);
      endedEarly.current.forEach((id) => remoteUrlOf(id) === url && endedEarly.current.delete(id));
      if (!gone.current) {
        setStarting((set) => {
          const next = new Set(set);
          next.delete(url);
          return next;
        });
      }
    }
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

  const initialLoading = feed.loading && feed.items.length === 0;

  return (
    <div className="explorer">
      <p className="hint explorer__caption">
        {query ? `Résultats pour « ${query} »` : "Sons populaires sur MyInstants"} · nécessite internet
      </p>
      {feed.error && feed.items.length === 0 ? (
        <ErrorPanel
          title="MyInstants est injoignable"
          message={`Vérifie ta connexion internet : ta banque locale, elle, fonctionne hors ligne. Détail : ${feed.error}`}
          action={<button type="button" className="btn" onClick={retry}>Réessayer</button>}
        />
      ) : initialLoading ? (
        <div className="remote-grid" aria-busy="true" aria-label="Chargement des sons">
          {Array.from({ length: 12 }, (_, i) => <div key={i} className="remote remote--skeleton" />)}
        </div>
      ) : feed.items.length === 0 ? (
        <EmptyState
          icon="search"
          title={`Aucun son pour « ${feed.query} »`}
          action={<button type="button" className="btn" onClick={onClearQuery}>Voir les sons populaires</button>}
        >
          Essaie un mot plus court ou en anglais.
        </EmptyState>
      ) : (
        <>
          <ul className="remote-grid" aria-label="Sons MyInstants" onKeyDown={onGridKeyDown}>
            {feed.items.map((s, i) => (
              <RemoteTile
                key={`${s.pageUrl}-${i}`}
                sound={s}
                seed={i}
                playing={playingMode(s)}
                starting={starting.has(s.mp3Url)}
                added={inBank.has(s.pageUrl)}
                categories={categories}
                onListen={(mode) => void listen(s, mode)}
                onAdd={(c) => add(s, c)}
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
              <>
                {feed.emptyPages >= MAX_EMPTY_AUTO_PAGES ? <p className="hint">Les dernières pages n'apportaient rien de nouveau.</p> : null}
                <button type="button" className="btn btn--ghost" onClick={loadNext}>Charger plus</button>
              </>
            ) : (
              <p className="hint">Fin des résultats.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

type Mode = "play" | "preview";

const soundKey = (s: RemoteSound) => s.mp3Url;

/** Playback ids of MyInstants sounds: `myinstants:<mp3 url>#<unique>` (see `play_remote` in src-tauri/src/state.rs). */
const REMOTE_ID_PREFIX = "myinstants:";

/** The sound a MyInstants playback id plays, or null for another id. */
function remoteUrlOf(id: string): string | null {
  const end = id.lastIndexOf("#");
  return id.startsWith(REMOTE_ID_PREFIX) && end > REMOTE_ID_PREFIX.length ? id.slice(REMOTE_ID_PREFIX.length, end) : null;
}

const TILE_COLORS = ["#b9a6ff", "#7fe7ff", "#ff9f1c", "#5cf28a", "#ff8ad8", "#ffd23f", "#ff5d5d"];
const NEW = "__new";

function RemoteTile({ sound, seed, playing, starting, added, categories, onListen, onAdd }: {
  sound: RemoteSound;
  seed: number;
  /** How it is playing right now, or null. */
  playing: Mode | null;
  starting: boolean;
  added: boolean;
  categories: string[];
  onListen: (mode: Mode) => void;
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
    <li className={`remote${playing ? " is-playing" : ""}${picking ? " is-picking" : ""}`}>
      <button
        type="button"
        data-grid-item
        className="remote__play"
        onClick={() => onListen("play")}
        disabled={starting}
        aria-busy={starting}
        title="Jouer (micro + casque)"
        aria-label={`${playing === "play" ? "Arrêter" : "Jouer"} ${sound.title}`}
      >
        <PixelIcon name={playing === "play" ? "stop" : "play"} scale={2} color={color} />
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
          <IconButton
            icon={playing === "preview" ? "stop" : "headphones"}
            size={1}
            className="remote__preview"
            disabled={starting}
            pressed={playing === "preview"}
            label={playing === "preview" ? `Arrêter l'aperçu de ${sound.title}` : `Aperçu de ${sound.title} (casque seulement)`}
            onClick={() => onListen("preview")}
          />
          {added ? (
            <span className="remote__added"><PixelIcon name="check" scale={1} /> Dans ta banque</span>
          ) : (
            <button type="button" className="btn btn--small" onClick={() => setPicking(true)}>
              <PixelIcon name="plus" scale={1} /> Ajouter
            </button>
          )}
        </div>
      )}
    </li>
  );
}
