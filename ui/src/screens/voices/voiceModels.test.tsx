import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render";
import type { MockOptions } from "../../ipc/mock";
import { VOICE_MODELS_DEBOUNCE_MS, cleanModelTitle } from "./VoiceModelsExplorer";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openExplorer(options: MockOptions = {}) {
  const user = userEvent.setup();
  const app = renderApp("voices", options);
  await user.click(await screen.findByRole("radio", { name: "IA" }));
  await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
  const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
  return { ...app, user, panel };
}

const rows = (panel: HTMLElement) =>
  within(within(panel).getByRole("list", { name: "Modèles voice-models.com" })).getAllByRole("listitem");

/** jsdom has no IntersectionObserver: capture the callbacks to fire them by hand. */
function stubIntersectionObserver() {
  const callbacks = new Set<IntersectionObserverCallback>();
  class Observer {
    constructor(private readonly cb: IntersectionObserverCallback) {}
    observe() {
      callbacks.add(this.cb);
    }
    disconnect() {
      callbacks.delete(this.cb);
    }
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  return () =>
    act(() => callbacks.forEach((cb) => cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)));
}

describe("voice-models.com explorer", () => {
  it("opens on the online source with the rights note, titles and sizes", async () => {
    const { panel, callsOf } = await openExplorer();
    expect(within(panel).getByRole("radio", { name: "voice-models.com" })).toHaveAttribute("aria-checked", "true");
    expect(within(panel).getByText(/appartiennent à leurs auteurs/)).toBeInTheDocument();
    await waitFor(() => expect(rows(panel)).toHaveLength(25));
    const first = rows(panel)[0] as HTMLElement;
    expect(within(first).getByText("Mario (Super Mario 64) [RVC v2] [500 Epochs]")).toBeInTheDocument();
    expect(within(first).getByText(/^\d+\.\d\d MB$/)).toBeInTheDocument();
    expect(callsOf("voicemodels_search")).toEqual([{ cmd: "voicemodels_search", args: { query: "", page: 1 } }]);
  });

  it("debounces the search and shows an empty state with a way back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: 20 });
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    await waitFor(() => expect(rows(panel)).toHaveLength(25));
    await user.type(within(panel).getByRole("searchbox", { name: "Rechercher un modèle" }), "yoda");
    expect(callsOf("voicemodels_search")).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(VOICE_MODELS_DEBOUNCE_MS + 10));
    expect(callsOf("voicemodels_search").at(-1)?.args).toEqual({ query: "yoda", page: 1 });
    expect(callsOf("voicemodels_search")).toHaveLength(2);
    await waitFor(() => expect(rows(panel)).toHaveLength(1));
    expect(within(panel).getByText("Fin des résultats.")).toBeInTheDocument();

    await user.clear(within(panel).getByRole("searchbox"));
    await user.type(within(panel).getByRole("searchbox"), "zzz");
    await act(() => vi.advanceTimersByTimeAsync(VOICE_MODELS_DEBOUNCE_MS + 10));
    expect(await within(panel).findByText("Aucun modèle pour « zzz »")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Voir tous les modèles" }));
    await act(() => vi.advanceTimersByTimeAsync(VOICE_MODELS_DEBOUNCE_MS + 10));
    await waitFor(() => expect(rows(panel)).toHaveLength(25));
  });

  it("loads the next page when the end of the list becomes visible, until the last one", async () => {
    const reachEnd = stubIntersectionObserver();
    const { panel, callsOf } = await openExplorer();
    await waitFor(() => expect(rows(panel)).toHaveLength(25));
    reachEnd();
    await waitFor(() => expect(rows(panel)).toHaveLength(50));
    reachEnd();
    await waitFor(() => expect(rows(panel)).toHaveLength(75));
    expect(within(panel).getByText("Fin des résultats.")).toBeInTheDocument();
    reachEnd();
    expect(callsOf("voicemodels_search").map((c) => (c.args as { page: number }).page)).toEqual([1, 2, 3]);
  });

  it("adds a model: editable cleaned name, download then conversion progress, then the new voice", async () => {
    const { panel, user, callsOf } = await openExplorer({ aiImportStepMs: 40 });
    await waitFor(() => expect(rows(panel).length).toBeGreaterThan(0));
    const row = rows(panel)[1] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Ajouter Darth Vader (Star Wars) [RVC v2]" }));
    const name = within(row).getByLabelText("Nom de la voix");
    expect(name).toHaveValue("Darth Vader (Star Wars)");
    await user.clear(name);
    await user.type(name, "Vador");
    await user.click(within(row).getByRole("button", { name: "Ajouter" }));
    expect(await within(panel).findByRole("progressbar", { name: "Téléchargement du modèle" })).toBeInTheDocument();
    expect(within(row).getByText("En cours…")).toBeInTheDocument();
    // Another model cannot start while this one runs.
    expect(within(rows(panel)[0] as HTMLElement).getByRole("button", { name: /^Ajouter/ })).toBeDisabled();
    // Nor a file import, and switching source does not lose the running add.
    await user.click(within(panel).getByRole("radio", { name: "Mes fichiers" }));
    expect(within(panel).getByText("Ajout de « Vador » depuis voice-models.com en cours…")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Choisir le \.pth/ })).toBeDisabled();
    await user.click(within(panel).getByRole("radio", { name: "voice-models.com" }));
    expect(await within(panel).findByRole("progressbar", { name: "Conversion du modèle" }, { timeout: 3000 })).toBeInTheDocument();
    const aiPanel = await screen.findByRole("complementary", { name: "Voix IA" }, { timeout: 3000 });
    expect(within(aiPanel).getByText("Vador")).toBeInTheDocument();
    expect(callsOf("voicemodels_add")[0]?.args).toEqual({
      url: "https://huggingface.co/mock/models/resolve/main/darth-vader-star-wars-rvc-v2.zip?download=true",
      name: "Vador",
    });
    expect(screen.getAllByRole("button", { name: /^Vador/ })).toHaveLength(1);
  });

  it("keeps the running add visible after a search hides its row, and in a reopened panel", async () => {
    const { panel, user } = await openExplorer({ aiImportStepMs: 30 });
    await user.type(within(panel).getByRole("searchbox", { name: "Rechercher un modèle" }), "yoda");
    await waitFor(() => expect(rows(panel)).toHaveLength(1));
    const row = rows(panel)[0] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /^Ajouter/ }));
    await user.click(within(row).getByRole("button", { name: "Ajouter" }));
    await user.clear(within(panel).getByRole("searchbox"));
    await user.type(within(panel).getByRole("searchbox"), "shrek");
    await waitFor(() => expect(within(rows(panel)[0] as HTMLElement).getByText(/^Shrek/)).toBeInTheDocument());
    expect(within(panel).getByText(/« Yoda \(Star Wars\) » : /)).toBeInTheDocument();
    expect(within(panel).getByRole("progressbar")).toBeInTheDocument();
    expect(within(rows(panel)[0] as HTMLElement).getByRole("button", { name: /^Ajouter/ })).toBeDisabled();

    await user.click(within(panel).getByRole("button", { name: "Fermer le panneau" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const reopened = screen.getByRole("complementary", { name: "Importer une voix IA" });
    expect(within(reopened).getByText(/« Yoda \(Star Wars\) » : /)).toBeInTheDocument();
    expect(await screen.findByText("Voix IA « Yoda (Star Wars) » prête", {}, { timeout: 4000 })).toBeInTheDocument();
    await waitFor(() => expect(within(reopened).queryByRole("progressbar")).not.toBeInTheDocument());
  }, 15_000);

  it("follows the catalogue's pagination through a page whose rows were all skipped", async () => {
    const reachEnd = stubIntersectionObserver();
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: { page?: number }) => {
      if (cmd === "voicemodels_search" && args.page === 1) return Promise.resolve({ models: [], hasMore: true });
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    expect(await within(panel).findByRole("button", { name: "Charger plus" })).toBeInTheDocument();
    expect(within(panel).queryByText(/Aucun modèle/)).not.toBeInTheDocument();
    reachEnd();
    await waitFor(() => expect(rows(panel)).toHaveLength(25));
  });

  it("lists a model once when the next page repeats it", async () => {
    const reachEnd = stubIntersectionObserver();
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: { page?: number }) => {
      // Page 2 answers page 1 again (the catalogue moved between the two requests).
      if (cmd === "voicemodels_search" && args.page === 2) return invoke(cmd as never, { ...args, page: 1 } as never);
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    await waitFor(() => expect(rows(panel)).toHaveLength(25));
    reachEnd();
    await waitFor(() => expect(backend.invoke).toHaveBeenCalledWith("voicemodels_search", { query: "", page: 2 }));
    await within(panel).findByRole("button", { name: "Charger plus" });
    expect(rows(panel)).toHaveLength(25);
  });

  it("stops fetching empty pages on its own after a few, and continues on demand", async () => {
    const reachEnd = stubIntersectionObserver();
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "voicemodels_search") {
        backend.calls.push({ cmd, args });
        return Promise.resolve({ models: [], hasMore: true });
      }
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    const pages = () => callsOf("voicemodels_search").map((c) => (c.args as { page: number }).page);
    await within(panel).findByRole("button", { name: "Charger plus" });
    for (let i = 0; i < 5; i++) {
      reachEnd();
      await waitFor(() => expect(within(panel).getByRole("button", { name: "Charger plus" })).toBeInTheDocument());
    }
    expect(pages()).toEqual([1, 2, 3]);
    await user.click(within(panel).getByRole("button", { name: "Charger plus" }));
    await waitFor(() => expect(pages()).toEqual([1, 2, 3, 4]));
  });

  it("retries the page that failed, not the first one", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    let failures = 1;
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: { page?: number }) => {
      if (cmd === "voicemodels_search" && (args.page === 1 || failures > 0)) {
        backend.calls.push({ cmd, args });
        if (args.page === 1) return Promise.resolve({ models: [], hasMore: true });
        failures -= 1;
        return Promise.reject(new Error("Coupure réseau"));
      }
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    await user.click(await within(panel).findByRole("button", { name: "Charger plus" }));
    expect(await within(panel).findByText("voice-models.com est injoignable")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(rows(panel)).toHaveLength(25));
    expect(callsOf("voicemodels_search").map((c) => (c.args as { page: number }).page)).toEqual([1, 2, 2]);
  });

  it("refuses an empty name without calling the backend", async () => {
    const { panel, user, callsOf } = await openExplorer();
    await waitFor(() => expect(rows(panel).length).toBeGreaterThan(0));
    const row = rows(panel)[0] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /^Ajouter/ }));
    await user.clear(within(row).getByLabelText("Nom de la voix"));
    await user.click(within(row).getByRole("button", { name: "Ajouter" }));
    expect(within(row).getByText("Donne un nom à cette voix IA.")).toBeInTheDocument();
    expect(callsOf("voicemodels_add")).toHaveLength(0);
  });

  it("shows a clear error on the row when the model cannot be added, and allows another try", async () => {
    const { panel, user } = await openExplorer();
    await user.type(within(panel).getByRole("searchbox", { name: "Rechercher un modèle" }), "bowser");
    await waitFor(() => expect(rows(panel)).toHaveLength(1));
    const row = rows(panel)[0] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /^Ajouter/ }));
    await user.click(within(row).getByRole("button", { name: "Ajouter" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(/Ajout impossible : .*pas une archive zip/);
    expect(within(row).getByRole("button", { name: "Ajouter" })).toBeEnabled();
    expect(screen.queryByRole("complementary", { name: "Voix IA" })).not.toBeInTheDocument();
  });

  it("still reports a failed add after a new search hid its row", async () => {
    const { panel, user, backend } = await openExplorer();
    // The add stays pending until the new search has replaced its row, then fails.
    let fail: (error: Error) => void = () => undefined;
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "voicemodels_add") return new Promise((_, reject) => (fail = reject));
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    const search = within(panel).getByRole("searchbox", { name: "Rechercher un modèle" });
    await user.type(search, "yoda");
    await waitFor(() => expect(rows(panel)).toHaveLength(1));
    const row = rows(panel)[0] as HTMLElement;
    await user.click(within(row).getByRole("button", { name: /^Ajouter/ }));
    await user.click(within(row).getByRole("button", { name: "Ajouter" }));
    await user.clear(search);
    await user.type(search, "shrek");
    await waitFor(() => expect(within(rows(panel)[0] as HTMLElement).getByText(/^Shrek/)).toBeInTheDocument());
    expect(within(panel).queryByText(/^Yoda/)).not.toBeInTheDocument();
    act(() => fail(new Error("Le fichier téléchargé n'est pas une archive zip.")));
    expect(await screen.findByText(/^Ajout de « .+ » impossible : .*pas une archive zip/)).toBeInTheDocument();
    await waitFor(() => expect(within(panel).queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it("explains when voice-models.com is unreachable and points to the offline import", async () => {
    const { panel, user } = await openExplorer({ voicemodelsOffline: true });
    expect(await within(panel).findByText("voice-models.com est injoignable")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Réessayer" })).toBeInTheDocument();
    await user.click(within(panel).getByRole("radio", { name: "Mes fichiers" }));
    expect(within(panel).getByRole("button", { name: /Choisir le \.pth/ })).toBeInTheDocument();
  });
});

describe("cleanModelTitle", () => {
  it("drops the site's technical tags but keeps meaningful parentheses", () => {
    expect(cleanModelTitle("Blank [RVC v2] [200 Epochs]")).toBe("Blank");
    expect(cleanModelTitle("GLaDOS - Portal 2 (RVC2) (240epoch) (RMVPE)")).toBe("GLaDOS - Portal 2");
    expect(cleanModelTitle("Geralt de Riv (VF) [RVC v2]")).toBe("Geralt de Riv (VF)");
    expect(cleanModelTitle("[RVC v2]")).toBe("[RVC v2]");
    expect(cleanModelTitle("x".repeat(60))).toHaveLength(40);
  });
});
