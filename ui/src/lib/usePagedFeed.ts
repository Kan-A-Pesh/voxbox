import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../state/store";
import { logClientError } from "./clientLog";

export type PagedFeed<T> = {
  query: string;
  items: T[];
  /** Last page loaded (0: none yet). */
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** Pages in a row that brought nothing new (rows all skipped by the parser, or all already listed). */
  emptyPages: number;
};

/** Past this many empty pages in a row, the next page waits for an explicit "Charger plus". */
export const MAX_EMPTY_AUTO_PAGES = 3;

export type FetchPage<T> = (query: string, page: number) => Promise<{ items: T[]; hasMore: boolean }>;

export type PagedFeedOptions<T> = {
  /** Identity of an item: when given, an item already listed is dropped (pages can overlap). Must be stable. */
  key?: (item: T) => string;
  /** When given, a later page's failure (shown inline, not by an error panel) is written to voxbox.log. */
  logContext?: string;
};

/**
 * A search feed with infinite scroll (MyInstants, voice-models.com): page 1 reloads on every
 * `query` change, older responses are ignored, and the next page loads when `sentinel` comes into
 * view. Infinite scroll stops on an error (only `retry` asks for the failed page again) and after
 * MAX_EMPTY_AUTO_PAGES empty pages in a row (`loadNext` continues on demand).
 * `fetchPage` must be stable (useCallback).
 */
export function usePagedFeed<T>(query: string, fetchPage: FetchPage<T>, { key, logContext }: PagedFeedOptions<T> = {}) {
  const [feed, setFeed] = useState<PagedFeed<T>>({
    query, items: [], page: 0, hasMore: true, loading: true, error: null, emptyPages: 0,
  });
  const request = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (q: string, page: number) => {
      const id = ++request.current;
      setFeed((f) => ({
        ...(page === 1 ? { query: q, items: [], page: 0, hasMore: true, emptyPages: 0 } : f),
        loading: true,
        error: null,
      }));
      try {
        const res = await fetchPage(q, page);
        if (id !== request.current) return;
        setFeed((f) => {
          // A page of repeats can still have new items after it: only several in a row stop the scroll.
          let fresh = res.items;
          if (key) {
            const known = new Set(page === 1 ? [] : f.items.map(key));
            fresh = res.items.filter((item) => {
              const k = key(item);
              if (known.has(k)) return false;
              known.add(k);
              return true;
            });
          }
          return {
            query: q,
            items: page === 1 ? fresh : [...f.items, ...fresh],
            page,
            hasMore: res.hasMore,
            loading: false,
            error: null,
            emptyPages: fresh.length === 0 ? (page === 1 ? 0 : f.emptyPages) + 1 : 0,
          };
        });
      } catch (e) {
        if (id !== request.current) return;
        // The first page's failure is shown (and logged) by an error panel; later ones inline.
        if (page > 1 && logContext) logClientError(logContext, errorMessage(e));
        setFeed((f) => ({ ...f, loading: false, error: errorMessage(e) }));
      }
    },
    [fetchPage, key, logContext],
  );

  useEffect(() => {
    void load(query, 1);
  }, [query, load]);

  /** Explicit "Charger plus". */
  const loadNext = useCallback(() => {
    if (!feed.loading && feed.hasMore && !feed.error) void load(feed.query, feed.page + 1);
  }, [feed, load]);
  /** Automatic, from the sentinel: bounded through empty pages. */
  const loadMore = useCallback(() => {
    if (feed.emptyPages < MAX_EMPTY_AUTO_PAGES) loadNext();
  }, [feed.emptyPages, loadNext]);
  /** The page that failed: page 1 after a first-load error, the next one otherwise. */
  const retry = useCallback(() => {
    if (!feed.loading) void load(feed.query, feed.page + 1);
  }, [feed, load]);

  // Re-created after every load: a sentinel still in view (short or empty page) asks for the next one.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), {
      rootMargin: "300px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  return { feed, loadNext, retry, sentinel };
}
