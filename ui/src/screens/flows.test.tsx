import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { createMockBackend, type MockBackend } from "../ipc/mock";
import { VoxProvider } from "../state/store";
import { App } from "../App";
import { SEARCH_DEBOUNCE_MS } from "./sounds/Explorer";
import { BUILTIN_PRESETS } from "../ipc/generated/presets";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const voiceCards = () =>
  within(screen.getByRole("list", { name: "Voix disponibles" })).getAllByRole("listitem");

describe("voice selection", () => {
  it("activates a voice on click and reflects it in the grid and the bottom bar", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    const robot = await screen.findByRole("button", { name: /^Robot/ });
    expect(robot).toHaveAttribute("aria-pressed", "false");
    await user.click(robot);
    expect(callsOf("set_active_voice")).toEqual([{ cmd: "set_active_voice", args: { id: "robot" } }]);
    expect(robot).toHaveAttribute("aria-pressed", "true");
    expect(robot).toHaveTextContent("Ctrl+Alt+2");
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("Robot")).toBeInTheDocument();
    expect(within(footer).getByText(/voix active · Ctrl\+Alt\+2/)).toBeInTheDocument();
  });

  it("filters by category and search", async () => {
    const user = userEvent.setup();
    renderApp("voices");
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    expect(voiceCards()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Importer une voix IA" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Créer une voix" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Toutes" }));
    expect(voiceCards()).toHaveLength(25);
    expect(screen.getByRole("button", { name: "Créer une voix" })).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Rechercher une voix" }), "cathedrale");
    expect(voiceCards()).toHaveLength(1);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText(/Aucune voix ne correspond/)).toBeInTheDocument();
  });

  it("offers Dupliquer on built-in voices and Modifier on custom and AI voices", async () => {
    renderApp("voices");
    expect(await screen.findByRole("button", { name: "Dupliquer Robot" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Modifier Robot" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Modifier Seigneur noir" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Modifier Voix féminine \(VCTK/ })).toBeInTheDocument();
  });

  it("follows hotkey-driven changes pushed through snapshot-changed", async () => {
    const { backend } = renderApp("voices");
    await screen.findByRole("button", { name: /^Extraterrestre/ });
    act(() => backend.simulateExternalChange((s) => (s.settings.activeVoiceId = "alien")));
    expect(screen.getByRole("button", { name: /^Extraterrestre/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles the voice changer from the bottom bar", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    const power = await screen.findByRole("switch", { name: "Changeur de voix" });
    expect(power).toBeChecked();
    await user.click(power);
    expect(power).not.toBeChecked();
    expect(callsOf("update_settings").at(-1)?.args).toEqual({ patch: { voiceEnabled: false } });
    expect(within(screen.getByRole("contentinfo")).getByText(/voix coupée/)).toBeInTheDocument();
  });

  it("toggles monitoring from the bottom bar", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    const monitor = await screen.findByRole("button", { name: "M'entendre" });
    const before = monitor.getAttribute("aria-pressed") === "true";
    await user.click(monitor);
    expect(monitor).toHaveAttribute("aria-pressed", String(!before));
    expect(callsOf("update_settings").at(-1)?.args).toEqual({ patch: { monitor: !before } });
  });

  it("warns in the bottom bar when the engine stops, and leads to Réglages", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    await screen.findByRole("button", { name: /^Robot/ });
    expect(screen.queryByRole("button", { name: /Moteur arrêté/ })).not.toBeInTheDocument();
    act(() => (backend as MockBackend).simulateDeviceLoss("Micro absent. Nouvelle tentative automatique…"));
    await user.click(await screen.findByRole("button", { name: /Moteur arrêté/ }));
    expect(await screen.findByRole("heading", { name: "Réglages" })).toBeInTheDocument();
    expect(screen.getByText("Le son est coupé, nouvelle tentative automatique")).toBeInTheDocument();
  });
});

describe("sound edit flow", () => {
  it("renames, colors and binds a hotkey, then saves through update_sound + set_hotkey", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("button", { name: "Modifier Oof" }));
    const panel = screen.getByRole("complementary", { name: "Modifier le son" });
    const name = within(panel).getByLabelText("Nom");
    await user.clear(name);
    await user.type(name, "Oof Roblox");
    expect(within(panel).queryByRole("switch", { name: /Lecture en boucle/ })).toBeNull();
    await user.click(within(panel).getByRole("radio", { name: "#ff9f1c" }));
    const capture = within(panel).getByRole("button", { name: /Raccourci pour Oof/ });
    await user.click(capture);
    fireEvent.keyDown(capture, { code: "KeyO", key: "o", ctrlKey: true, altKey: true });
    expect(capture).toHaveTextContent("Ctrl+Alt+O");
    await user.click(within(panel).getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(callsOf("update_sound")).toHaveLength(1));
    expect(callsOf("update_sound")[0]?.args).toMatchObject({
      sound: { id: "snd-oof", name: "Oof Roblox", color: "#ff9f1c", hotkey: "Ctrl+Alt+O" },
    });
    await waitFor(() =>
      expect(callsOf("set_hotkey")[0]?.args).toEqual({ action: { type: "sound", id: "snd-oof" }, accelerator: "Ctrl+Alt+O" }),
    );
    expect(await screen.findByRole("button", { name: "Jouer Oof Roblox" })).toHaveTextContent("Ctrl+Alt+O");
  });

  it("loops a sound in one click from the bank, and lists favorites first", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("button", { name: "Jouer Oof en boucle" }));
    await waitFor(() => expect(callsOf("update_sound")[0]?.args).toMatchObject({ sound: { id: "snd-oof", loop: true } }));
    expect(await screen.findByRole("button", { name: "Ne plus jouer Oof en boucle" })).toHaveAttribute("aria-pressed", "true");

    const pads = () => screen.getAllByRole("button", { name: /^(Jouer|Arrêter) (?!.* en boucle$)/ }).map((b) => b.getAttribute("aria-label"));
    const before = pads();
    const last = before[before.length - 1]!.replace(/^Jouer /, "");
    await user.click(screen.getByRole("button", { name: `Ajouter ${last} aux favoris` }));
    // It joins the favorites at the top (after those already starred).
    await waitFor(() => expect(pads().indexOf(`Jouer ${last}`)).toBeLessThan(before.length - 1));
    const favoriteCount = screen.getAllByRole("button", { name: /^Retirer .* des favoris$/ }).length;
    expect(pads().indexOf(`Jouer ${last}`)).toBeLessThan(favoriteCount);
  });

  it("moves a hotkey to another sound, and favouriting the former owner does not steal it back", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("sounds");
    // "Corne de brume" owns Numpad1; give Numpad1 to "Bruh".
    await user.click(await screen.findByRole("button", { name: "Modifier Bruh" }));
    const panel = screen.getByRole("complementary", { name: "Modifier le son" });
    const capture = within(panel).getByRole("button", { name: /^Raccourci pour Bruh/ });
    await user.click(capture);
    fireEvent.keyDown(capture, { code: "Numpad1", key: "1" });
    await user.click(within(panel).getByRole("button", { name: "Enregistrer" }));
    expect(await screen.findByRole("button", { name: "Jouer Bruh" })).toHaveTextContent("Numpad1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Jouer Corne de brume" })).not.toHaveTextContent("Numpad1"));

    const before = callsOf("update_sound").length;
    await user.click(screen.getByRole("button", { name: /Corne de brume des favoris|Corne de brume aux favoris/ }));
    await waitFor(() => expect(callsOf("update_sound")).toHaveLength(before + 1));
    expect(callsOf("update_sound").at(-1)?.args).toMatchObject({ sound: { id: "snd-airhorn", hotkey: null } });
    const snap = await backend.invoke("get_snapshot", {});
    expect(snap.hotkeys.filter((h) => h.accelerator === "Numpad1")).toEqual([
      { action: { type: "sound", id: "snd-bruh" }, accelerator: "Numpad1" },
    ]);
    expect(screen.getByRole("button", { name: "Jouer Bruh" })).toHaveTextContent("Numpad1");
  });

  it("refuses an empty name inline without calling the backend", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("button", { name: "Modifier Wow" }));
    const panel = screen.getByRole("complementary", { name: "Modifier le son" });
    await user.clear(within(panel).getByLabelText("Nom"));
    await user.click(within(panel).getByRole("button", { name: "Enregistrer" }));
    expect(within(panel).getByText("Donne un nom à ce son.")).toBeInTheDocument();
    expect(callsOf("update_sound")).toHaveLength(0);
  });

  it("deletes a sound after confirmation", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("button", { name: "Modifier Wow" }));
    await user.click(screen.getByRole("button", { name: "Supprimer ce son" }));
    await user.click(screen.getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Jouer Wow" })).not.toBeInTheDocument());
    expect(callsOf("delete_sound")[0]?.args).toEqual({ id: "snd-wow" });
  });

  it("plays and stops a pad, and stops everything from the header", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    const stopAll = await screen.findByRole("button", { name: "Tout arrêter" });
    expect(stopAll).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Jouer Oof" }));
    expect(callsOf("play_sound")[0]?.args).toMatchObject({ id: "snd-oof" });
    await user.click(await screen.findByRole("button", { name: "Arrêter Oof" }));
    expect(callsOf("stop_sound")[0]?.args).toMatchObject({ id: "snd-oof" });
    await user.click(await screen.findByRole("button", { name: "Jouer Bruh" }));
    await waitFor(() => expect(stopAll).toBeEnabled());
    await user.click(stopAll);
    expect(callsOf("stop_all_sounds")).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "Jouer Bruh" })).toBeInTheDocument();
  });

  it("imports sounds with the Importer button", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("button", { name: "Importer" }));
    expect(await screen.findByRole("button", { name: "Jouer Klaxon" })).toBeInTheDocument();
    expect(callsOf("import_sounds")[0]?.args).toEqual({
      paths: ["C:\\Users\\moi\\Sons\\Klaxon.mp3", "C:\\Users\\moi\\Sons\\Rire diabolique.wav", "C:\\Users\\moi\\Sons\\Gong.ogg"],
    });
  });

  it("filters the bank by text and by category", async () => {
    const user = userEvent.setup();
    renderApp("sounds");
    const pads = () => within(screen.getByRole("list", { name: "Sons de ta banque" })).getAllByRole("listitem");
    await screen.findByRole("button", { name: "Jouer Oof" });
    const all = pads().length;
    await user.click(screen.getByRole("radio", { name: /^Favoris/ }));
    expect(pads().length).toBeLessThan(all);
    expect(screen.getByRole("button", { name: "Jouer Bruh" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /^Tous/ }));
    await user.type(screen.getByRole("searchbox", { name: "Rechercher un son" }), "brume");
    expect(pads()).toHaveLength(1);
    await user.clear(screen.getByRole("searchbox", { name: "Rechercher un son" }));
    await user.type(screen.getByRole("searchbox", { name: "Rechercher un son" }), "zzz");
    await user.click(screen.getByRole("button", { name: "Effacer la recherche" }));
    expect(pads()).toHaveLength(all);
  });

  it("imports dropped files", async () => {
    const { backend, callsOf } = renderApp("sounds");
    await screen.findByRole("button", { name: "Jouer Oof" });
    await waitFor(() => expect(backend.hasDropListener()).toBe(true));
    act(() => backend.simulateDrop(["C:\\Sons\\Gong.ogg", "C:\\Sons\\notes.txt"]));
    expect(await screen.findByRole("button", { name: "Jouer Gong" })).toBeInTheDocument();
    expect(callsOf("import_sounds")[0]?.args).toEqual({ paths: ["C:\\Sons\\Gong.ogg"] });
  });
});

describe("MyInstants explorer", () => {
  it("debounces the search: one request after typing stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: 50 });
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await screen.findByRole("button", { name: "Jouer Vine boom" });
    await user.type(screen.getByRole("searchbox", { name: "Rechercher sur MyInstants" }), "bruh");
    expect(callsOf("myinstants_search")).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10));
    expect(callsOf("myinstants_search")).toEqual([{ cmd: "myinstants_search", args: { query: "bruh", page: 1 } }]);
    expect(await screen.findByRole("button", { name: "Jouer Bruh" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jouer Vine boom" })).not.toBeInTheDocument();
  });

  it("shows a recoverable error when MyInstants is unreachable", async () => {
    const user = userEvent.setup();
    renderApp("sounds", { myinstantsOffline: true });
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    expect(await screen.findByText("MyInstants est injoignable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeInTheDocument();
  });

  it("keeps each MyInstants sound once, goes past repeats, pauses scrolling after several", async () => {
    // jsdom has no IntersectionObserver: a stand-in lets the test scroll to the end.
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly cb: (entries: { isIntersecting: boolean }[]) => void) {}
        observe() {
          observers.push(() => this.cb([{ isIntersecting: true }]));
        }
        disconnect() {}
      },
    );
    const scrollToEnd = () => act(() => observers.at(-1)?.());
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    // The live site has no "next" link: pages keep saying there may be more, and they
    // overlap. Page 3 is new, page 7 is new, every other page repeats page 1.
    const source = (page?: number) => (page === 3 ? 2 : page === 7 ? 3 : 1);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: { page?: number }) =>
      cmd === "myinstants_trending"
        ? invoke("myinstants_trending", { page: source(args.page) }).then((p) => ({ ...p, hasMore: true }))
        : invoke(cmd as never, args as never)) as typeof backend.invoke);
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    const count = () => screen.getAllByRole("button", { name: /^Jouer / }).length;
    const first = (await screen.findAllByRole("button", { name: /^Jouer / })).length;
    const loadPage = async (page: number) => {
      await scrollToEnd();
      await waitFor(() => expect(callsOf("myinstants_trending")).toHaveLength(page));
      await waitFor(() => expect(screen.queryByText(/^Chargement/)).not.toBeInTheDocument());
    };
    await loadPage(2);
    expect(count()).toBe(first); // a page of repeats adds no card
    await loadPage(3);
    await waitFor(() => expect(count()).toBeGreaterThan(first)); // page 3 brought new sounds
    const afterRepeats = count();
    for (let page = 4; page <= 6; page++) await loadPage(page);
    expect(count()).toBe(afterRepeats); // pages 4 to 6 repeat: still no new card
    // Three pages of repeats in a row: scrolling no longer loads on its own.
    expect(await screen.findByText(/n'apportaient rien de nouveau/)).toBeInTheDocument();
    await scrollToEnd();
    expect(callsOf("myinstants_trending")).toHaveLength(6);
    // "Charger plus" still reaches the next page, which has new sounds.
    await user.click(screen.getByRole("button", { name: "Charger plus" }));
    await waitFor(() => expect(count()).toBeGreaterThan(afterRepeats));
    expect(callsOf("myinstants_trending")).toHaveLength(7);
  });

  it("retries a failed page from the pagination error", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    let failNext = true;
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: { page?: number }) => {
      if (cmd === "myinstants_trending" && args.page === 2 && failNext) {
        failNext = false;
        return Promise.reject(new Error("Coupure réseau"));
      }
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await user.click(await screen.findByRole("button", { name: "Charger plus" }));
    expect(await screen.findByText(/Coupure réseau/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(screen.queryByText(/Coupure réseau/)).not.toBeInTheDocument());
    expect(callsOf("myinstants_trending").filter((c) => (c.args as { page: number }).page === 2)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Charger plus" })).toBeInTheDocument();
  });

  it("adds a sound to the bank with a category", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    const tile = (await screen.findByRole("button", { name: "Jouer Tuturu" })).closest("li") as HTMLElement;
    await user.click(within(tile).getByRole("button", { name: /Ajouter/ }));
    await user.selectOptions(within(tile).getByLabelText("Catégorie"), "Mèmes");
    await user.click(within(tile).getByRole("button", { name: "Ajouter" }));
    expect(await within(tile).findByText("Dans ta banque")).toBeInTheDocument();
    expect(callsOf("myinstants_add")[0]?.args).toMatchObject({ sound: { title: "Tuturu" }, category: "Mèmes" });
  });
});

describe("voice editor panel", () => {
  it("duplicates a built-in voice, previews live, saves, and clears the preview on close", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    const robotPreset = BUILTIN_PRESETS.find((v) => v.id === "robot");
    if (!robotPreset) throw new Error("robot preset missing");
    await user.click(await screen.findByRole("button", { name: "Dupliquer Robot" }));
    const panel = screen.getByRole("complementary", { name: "Dupliquer la voix" });
    expect(within(panel).getByLabelText("Nom")).toHaveValue("Robot (copie)");
    await waitFor(() =>
      expect(callsOf("preview_effects").at(-1)?.args).toMatchObject({ effects: robotPreset.effects }),
    );
    await user.click(within(panel).getByRole("button", { name: "Créer la voix" }));
    await waitFor(() => expect(callsOf("save_voice")).toHaveLength(1));
    expect(callsOf("save_voice")[0]?.args).toMatchObject({ voice: { id: "", name: "Robot (copie)", builtin: false } });
    expect(await screen.findByRole("button", { name: /^Robot \(copie\)/ })).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Fermer le panneau" }));
    expect(panel).not.toBeInTheDocument();
    expect(callsOf("preview_effects").at(-1)?.args).toEqual({ effects: null });
  });

  it("clears the live preview when leaving the Voix screen", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Modifier Seigneur noir" }));
    await waitFor(() => expect(callsOf("preview_effects").at(-1)?.args).not.toEqual({ effects: null }));
    await user.click(screen.getByRole("button", { name: "Sons" }));
    expect(callsOf("preview_effects").at(-1)?.args).toEqual({ effects: null });
  });

  it("creates a voice from scratch: icon, colour, an effect, then uses it", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Créer une voix" }));
    const panel = screen.getByRole("complementary", { name: "Nouvelle voix" });
    const name = within(panel).getByLabelText("Nom");
    await user.clear(name);
    await user.type(name, "Ma voix grave");
    expect(within(panel).queryByRole("radiogroup", { name: "Icône" })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Changer d'icône" }));
    await user.click(within(panel).getByRole("radio", { name: "ghost" }));
    expect(within(panel).queryByRole("radiogroup", { name: "Icône" })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("radio", { name: "#5cf28a" }));
    await user.click(within(panel).getByRole("button", { name: "Ajouter" }));
    expect(within(panel).getAllByRole("slider").length).toBeGreaterThan(0);
    await user.click(within(panel).getByRole("button", { name: "Créer la voix" }));
    await waitFor(() => expect(callsOf("save_voice")).toHaveLength(1));
    expect(callsOf("save_voice")[0]?.args).toMatchObject({
      voice: { name: "Ma voix grave", icon: "ghost", color: "#5cf28a", effects: [{ kind: "pitchShift" }] },
    });
    await user.click(await within(panel).findByRole("button", { name: "Utiliser" }));
    await waitFor(() => expect(callsOf("set_active_voice")).toHaveLength(1));
    expect(within(screen.getByRole("contentinfo")).getByText("Ma voix grave")).toBeInTheDocument();
  });

  it("locks the form while saving so nothing typed meanwhile is lost", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    let release: () => void = () => {};
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "save_voice") return new Promise((r) => (release = () => r(invoke("save_voice", args as never))));
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: "Créer une voix" }));
    const panel = screen.getByRole("complementary", { name: "Nouvelle voix" });
    await user.click(within(panel).getByRole("button", { name: "Créer la voix" }));
    expect(within(panel).getByLabelText("Nom")).toBeDisabled();
    await act(async () => release());
    await waitFor(() => expect(within(panel).getByLabelText("Nom")).toBeEnabled());
  });

  it("refuses an empty voice name inline without calling the backend", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Créer une voix" }));
    const panel = screen.getByRole("complementary", { name: "Nouvelle voix" });
    await user.clear(within(panel).getByLabelText("Nom"));
    await user.click(within(panel).getByRole("button", { name: "Créer la voix" }));
    expect(within(panel).getByText("Donne un nom à ta voix.")).toBeInTheDocument();
    expect(callsOf("save_voice")).toHaveLength(0);
  });

  it("edits a custom voice: one effect expanded at a time, reorder, disable, save", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Modifier Seigneur noir" }));
    const panel = screen.getByRole("complementary", { name: "Modifier la voix" });
    const save = within(panel).getByRole("button", { name: "Enregistrer" });
    expect(save).toBeDisabled();
    const chain = within(panel).getByRole("list", { name: "Effets de la voix" });
    const expanded = () => within(chain).getAllByRole("button", { expanded: true });
    expect(expanded()).toHaveLength(1);
    const [, second] = within(chain).getAllByRole("listitem") as HTMLElement[];
    await user.click(within(second as HTMLElement).getByRole("button", { expanded: false }));
    expect(expanded()).toHaveLength(1);
    expect(within(second as HTMLElement).getByRole("button", { expanded: true })).toBeInTheDocument();
    const firstLabel = within(within(chain).getAllByRole("listitem")[0] as HTMLElement).getByRole("button", { expanded: false }).textContent?.replace(/^\d+/, "") ?? "";
    await user.click(within(panel).getByRole("button", { name: `Descendre ${firstLabel}` }));
    await user.click(within(within(chain).getAllByRole("listitem")[1] as HTMLElement).getByRole("switch", { name: "Actif" }));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(callsOf("save_voice")).toHaveLength(1));
    const effects = (callsOf("save_voice")[0]?.args as { voice: { id: string; effects: { enabled: boolean }[] } }).voice;
    expect(effects.id).toBe("custom-dark-lord");
    expect(effects.effects[1]?.enabled).toBe(false);
    await waitFor(() => expect(save).toBeDisabled());
  });

  it("deletes a custom voice after confirmation and closes the panel", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Modifier Seigneur noir" }));
    await user.click(screen.getByRole("button", { name: "Supprimer cette voix" }));
    await user.click(screen.getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Seigneur noir/ })).not.toBeInTheDocument());
    expect(callsOf("delete_voice")[0]?.args).toEqual({ id: "custom-dark-lord" });
    expect(screen.queryByRole("complementary", { name: "Modifier la voix" })).not.toBeInTheDocument();
  });

  it("asks before leaving the Voix screen with an unsaved draft", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Créer une voix" }));
    const panel = screen.getByRole("complementary", { name: "Nouvelle voix" });
    await user.type(within(panel).getByLabelText("Nom"), " grave");
    await user.click(screen.getByRole("button", { name: "Sons" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(panel).toBeInTheDocument();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Sons" }));
    expect(await screen.findByRole("heading", { name: "Sons" })).toBeInTheDocument();
  });

  it("leaves an untouched new draft without asking", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Créer une voix" }));
    await user.click(screen.getByRole("button", { name: "Réglages" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Réglages" })).toBeInTheDocument();
  });

  it("closes the editor and its preview when another voice is chosen", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Modifier Seigneur noir" }));
    await waitFor(() => expect(callsOf("preview_effects").at(-1)?.args).not.toEqual({ effects: null }));
    await user.click(screen.getByRole("button", { name: /^Robot/ }));
    expect(screen.queryByRole("complementary", { name: "Modifier la voix" })).not.toBeInTheDocument();
    expect(callsOf("preview_effects").at(-1)?.args).toEqual({ effects: null });
    expect(callsOf("set_active_voice").at(-1)?.args).toEqual({ id: "robot" });
  });

  it("clamps slider input to the descriptor range", async () => {
    const user = userEvent.setup();
    renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Créer une voix" }));
    await user.click(screen.getByRole("button", { name: "Ajouter" }));
    const slider = (await screen.findAllByRole("slider", { name: "Demi-tons" }))[0] as HTMLInputElement;
    // Real catalog: semitones in [-12, 12], step 0.1.
    fireEvent.change(slider, { target: { value: "3.34" } });
    expect(slider.value).toBe("3.3");
    fireEvent.change(slider, { target: { value: "3.36" } });
    expect(slider.value).toBe("3.4");
  });
});

describe("AI voices", () => {
  it("imports an RVC model from the IA filter, shows progress, then opens the new voice", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    await user.click(within(panel).getByRole("radio", { name: "Mes fichiers" }));
    const submit = within(panel).getByRole("button", { name: "Importer" });
    expect(submit).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: /Choisir le \.pth/ }));
    expect(within(panel).getByText("dark-vador.pth")).toBeInTheDocument();
    expect(within(panel).getByLabelText("Nom de la voix")).toHaveValue("dark vador");
    await user.click(within(panel).getByRole("button", { name: /Choisir l'index/ }));
    expect(within(panel).getByText("dark-vador.index")).toBeInTheDocument();
    await user.click(submit);
    expect(await within(panel).findByRole("progressbar", { name: "Conversion du modèle" })).toBeInTheDocument();
    const aiPanel = await screen.findByRole("complementary", { name: "Voix IA" });
    expect(within(aiPanel).getByText("dark vador")).toBeInTheDocument();
    expect(callsOf("import_ai_model")[0]?.args).toMatchObject({
      pthPath: "C:\\Users\\moi\\Modèles\\dark-vador.pth",
      indexPath: "C:\\Users\\moi\\Modèles\\dark-vador.index",
      name: "dark vador",
    });
    expect(screen.getAllByRole("button", { name: /^dark vador/ })).toHaveLength(1);
  });

  it("shows an import failure inline and keeps the form", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    vi.spyOn(backend, "pickFiles").mockResolvedValue(["C:\\Modèles\\corrompu.pth"]);
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    await user.click(within(panel).getByRole("radio", { name: "Mes fichiers" }));
    await user.click(within(panel).getByRole("button", { name: /Choisir le \.pth/ }));
    await user.click(within(panel).getByRole("button", { name: "Importer" }));
    expect(await within(panel).findByText("Import impossible")).toBeInTheDocument();
    expect(within(panel).getByText(/corrompu ou n'est pas un modèle RVC v2/)).toBeInTheDocument();
    expect(within(panel).getByLabelText("Nom de la voix")).toHaveValue("corrompu");
  });

  it("refuses an AI import without a name", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    await user.click(within(panel).getByRole("radio", { name: "Mes fichiers" }));
    await user.click(within(panel).getByRole("button", { name: /Choisir le \.pth/ }));
    await user.clear(within(panel).getByLabelText("Nom de la voix"));
    await user.click(within(panel).getByRole("button", { name: "Importer" }));
    expect(within(panel).getByText("Donne un nom à cette voix IA.")).toBeInTheDocument();
    expect(callsOf("import_ai_model")).toHaveLength(0);
  });

  it("tunes the shared RVC settings within their limits and shows what the backend accepted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { backend, callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("button", { name: /^Modifier Voix féminine \(VCTK/ }));
    const panel = screen.getByRole("complementary", { name: "Voix IA" });
    const pitch = within(panel).getByRole("slider", { name: "Hauteur" });
    expect(pitch).toHaveAttribute("min", "-12");
    expect(pitch).toHaveAttribute("max", "12");
    const block = within(panel).getByRole("slider", { name: "Taille de bloc" });
    const fade = within(panel).getByRole("slider", { name: "Fondu entre blocs" });
    fireEvent.change(pitch, { target: { value: "12" } });
    // A short block caps the crossfade at half a block.
    fireEvent.change(fade, { target: { value: "200" } });
    fireEvent.change(block, { target: { value: "100" } });
    expect(fade).toHaveAttribute("max", "50");
    expect(fade).toHaveValue("50");
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(callsOf("update_settings").at(-1)?.args).toEqual({
      patch: { aiParams: { pitchSemitones: 12, indexRate: 0.75, blockMs: 100, crossfadeMs: 50 } },
    });
    // The backend changes them elsewhere (e.g. another window): the panel follows.
    act(() => backend.simulateExternalChange((s) => (s.settings.aiParams = { ...s.settings.aiParams, pitchSemitones: -3 })));
    expect(within(panel).getByRole("slider", { name: "Hauteur" })).toHaveValue("-3");
  });

  it("sends a pending RVC change when the panel closes before the delay", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("button", { name: /^Modifier Voix féminine \(VCTK/ }));
    const panel = screen.getByRole("complementary", { name: "Voix IA" });
    fireEvent.change(within(panel).getByRole("slider", { name: "Hauteur" }), { target: { value: "5" } });
    await user.click(within(panel).getByRole("button", { name: "Fermer le panneau" }));
    await waitFor(() =>
      expect(callsOf("update_settings").at(-1)?.args).toMatchObject({ patch: { aiParams: { pitchSemitones: 5 } } }),
    );
  });

  it("reports an import failure as a toast once the panel is closed", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices", { aiImportStepMs: 150 });
    vi.spyOn(backend, "pickFiles").mockResolvedValue(["C:\\Modèles\\corrompu.pth"]);
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    await user.click(within(panel).getByRole("radio", { name: "Mes fichiers" }));
    await user.click(within(panel).getByRole("button", { name: /Choisir le \.pth/ }));
    await user.click(within(panel).getByRole("button", { name: "Importer" }));
    await user.click(within(panel).getByRole("button", { name: "Fermer le panneau" }));
    expect(await screen.findByText(/Import de « corrompu » impossible/)).toBeInTheDocument();
  });

  it("keeps a newer panel open when an older deletion finishes", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    let release: () => void = () => {};
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "delete_voice") return new Promise((r) => (release = () => r(invoke("delete_voice", args as never))));
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: "Modifier Seigneur noir" }));
    await user.click(screen.getByRole("button", { name: "Supprimer cette voix" }));
    await user.click(screen.getByRole("button", { name: "Supprimer" }));
    await user.click(screen.getByRole("button", { name: "Dupliquer Robot" }));
    const newer = screen.getByRole("complementary", { name: "Dupliquer la voix" });
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Seigneur noir/ })).not.toBeInTheDocument());
    expect(newer).toBeInTheDocument();
  });

  it("keeps a voice chosen while a closing RVC change is still in flight", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    let release: () => void = () => {};
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "update_settings") {
        // Committed now with the old active voice in its answer, delivered late.
        const answer = invoke("update_settings", args as never);
        return new Promise((r) => (release = () => r(answer)));
      }
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: /^Modifier Voix féminine \(VCTK/ }));
    const panel = screen.getByRole("complementary", { name: "Voix IA" });
    fireEvent.change(within(panel).getByRole("slider", { name: "Hauteur" }), { target: { value: "5" } });
    await user.click(within(panel).getByRole("button", { name: "Fermer le panneau" }));
    await user.click(screen.getByRole("button", { name: /^Robot/ }));
    await act(async () => release());
    expect(screen.getByRole("button", { name: /^Robot/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("contentinfo")).getByText("Robot")).toBeInTheDocument();
  });

  it("keeps the latest voice choice when an older selection answers last", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    let release: () => void = () => {};
    let first = true;
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "set_active_voice" && first) {
        first = false;
        const answer = invoke("set_active_voice", args as never);
        return new Promise((r) => (release = () => r(answer)));
      }
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: /^Robot/ }));
    await user.click(screen.getByRole("button", { name: /^Modifier Voix féminine \(VCTK/ }));
    const panel = screen.getByRole("complementary", { name: "Voix IA" });
    await user.click(within(panel).getByRole("button", { name: "Utiliser" }));
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Voix active" })).toBeDisabled());
    await act(async () => release());
    expect(screen.getByRole("button", { name: /^Robot/ })).toHaveAttribute("aria-pressed", "false");
    expect(within(screen.getByRole("contentinfo")).getByText("Voix féminine (VCTK p231)")).toBeInTheDocument();
  });

  it("keeps a newer RVC edit when an earlier one is rejected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { backend, callsOf } = renderApp("settings");
    const invoke = backend.invoke.bind(backend);
    let reject: () => void = () => {};
    let first = true;
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "update_settings" && first && "aiParams" in (args as { patch: object }).patch) {
        first = false;
        return new Promise((_, r) => (reject = () => r(new Error("Réglages IA refusés"))));
      }
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    const pitch = await screen.findByRole("slider", { name: "Hauteur" });
    fireEvent.change(pitch, { target: { value: "3" } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    fireEvent.change(pitch, { target: { value: "7" } });
    await act(() => vi.advanceTimersByTimeAsync(100));
    await act(async () => reject());
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(callsOf("update_settings").at(-1)?.args).toMatchObject({ patch: { aiParams: { pitchSemitones: 7 } } });
    await waitFor(() => expect(screen.getByRole("slider", { name: "Hauteur" })).toHaveValue("7"));
  });

  it("keeps a voice chosen by hotkey while an on-screen choice is still answering", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    let release: () => void = () => {};
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "set_active_voice") {
        const answer = invoke("set_active_voice", args as never);
        return new Promise((r) => (release = () => r(answer)));
      }
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: /^Robot/ }));
    act(() => backend.simulateExternalChange((s) => (s.settings.activeVoiceId = "alien")));
    await act(async () => release());
    expect(screen.getByRole("button", { name: /^Extraterrestre/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Robot/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the previous voice when the chosen one fails to load, so it can be retried", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) =>
      cmd === "set_active_voice" && (args as { id: string }).id === "ai-vctk-p226"
        ? Promise.reject(new Error("Le flux RVC n'a pas démarré."))
        : invoke(cmd as never, args as never)) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: /^Modifier Voix masculine \(VCTK/ }));
    const panel = screen.getByRole("complementary", { name: "Voix IA" });
    await user.click(within(panel).getByRole("button", { name: "Utiliser" }));
    expect(await screen.findByText("Le flux RVC n'a pas démarré.")).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Utiliser" })).toBeEnabled());
    expect(within(screen.getByRole("contentinfo")).getByText("Villageois")).toBeInTheDocument();
  });

  it("runs one AI import at a time and shows it in a reopened panel", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices", { aiImportStepMs: 150 });
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    let panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    await user.click(within(panel).getByRole("radio", { name: "Mes fichiers" }));
    await user.click(within(panel).getByRole("button", { name: /Choisir le \.pth/ }));
    await user.click(within(panel).getByRole("button", { name: "Importer" }));
    await user.click(within(panel).getByRole("button", { name: "Fermer le panneau" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    expect(within(panel).getByText(/Conversion de « dark vador »/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Conversion…" })).toBeDisabled();
    expect(callsOf("import_ai_model")).toHaveLength(1);
    expect(await screen.findByText("Voix IA « dark vador » prête", {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => expect(within(panel).queryByText(/Conversion de/)).not.toBeInTheDocument());
  });

  it("uses an AI voice and deletes an imported model after confirmation", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    let panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    await user.click(within(panel).getByRole("radio", { name: "Mes fichiers" }));
    await user.click(within(panel).getByRole("button", { name: /Choisir le \.pth/ }));
    await user.click(within(panel).getByRole("button", { name: "Importer" }));
    panel = await screen.findByRole("complementary", { name: "Voix IA" });
    await user.click(within(panel).getByRole("button", { name: "Utiliser" }));
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Voix active" })).toBeDisabled());
    await user.click(within(panel).getByRole("button", { name: "Supprimer cette voix IA" }));
    await user.click(within(panel).getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(panel).not.toBeInTheDocument());
    expect(callsOf("delete_ai_model")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^dark vador/ })).not.toBeInTheDocument();
  });

  it("does not offer to delete a bundled AI voice", async () => {
    const user = userEvent.setup();
    renderApp("voices");
    await user.click(await screen.findByRole("button", { name: /^Modifier Voix féminine \(VCTK/ }));
    const panel = screen.getByRole("complementary", { name: "Voix IA" });
    expect(within(panel).getByText(/Licence/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /Supprimer/ })).not.toBeInTheDocument();
  });
});

describe("settings", () => {
  it("shows the VB-Cable attribution with its link", async () => {
    renderApp("settings");
    const link = await screen.findByRole("link", { name: "www.vb-cable.com" });
    expect(link).toHaveAttribute("href", "https://www.vb-cable.com");
    expect(link.closest("p")).toHaveTextContent(
      "VB-CABLE est un donationware de VB-Audio (www.vb-cable.com), toutes les participations sont les bienvenues.",
    );
  });

  it("recovers from an unplugged USB headset: changing one device resets the other missing one", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("settings", { unpluggedHeadset: true });
    const monitor = await screen.findByLabelText(/Casque/);
    await user.selectOptions(monitor, "out-realtek");
    await waitFor(() => expect(callsOf("update_settings")).toHaveLength(1));
    // The stale microphone travels with the patch, the backend drops it instead of failing.
    expect(callsOf("update_settings")[0]?.args).toMatchObject({ patch: { devices: { input: "usb-headset-mic", monitor: "out-realtek" } } });
    await waitFor(() => expect(screen.getByLabelText(/Micro/)).toHaveValue(""));
    expect(screen.getByLabelText(/Casque/)).toHaveValue("out-realtek");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("after a rejected settings change, shows the settings the backend really holds", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("settings");
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "update_settings") {
        // The backend applies part of the change, then reports a failure.
        return invoke("update_settings", { patch: { devices: { input: null, cable: null, monitor: "out-realtek" } } }).then(() => {
          throw new Error("Réglages non enregistrés");
        });
      }
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.selectOptions(await screen.findByLabelText(/Casque/), "out-arctis");
    expect(await screen.findByText(/Réglages non enregistrés/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Casque/)).toHaveValue("out-realtek"));
    expect(callsOf("get_snapshot").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the engine as stopped after a device is lost, without waiting for another change", async () => {
    const { backend } = renderApp("settings");
    expect(await screen.findByText(/Latence mesurée/)).toBeInTheDocument();
    act(() => (backend as MockBackend).simulateDeviceLoss("Le périphérique audio a été déconnecté"));
    expect(await screen.findByText(/a été déconnecté/)).toBeInTheDocument();
    expect(await screen.findAllByText(/moteur arrêté/)).not.toHaveLength(0);
  });

  it("shows why the sound stopped, then clears it when the engine restarts on its own", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("settings");
    await screen.findByText(/Latence mesurée/);
    act(() => (backend as MockBackend).simulateDeviceLoss("Micro « Shure MV7 (USB) » : périphérique audio introuvable. Nouvelle tentative automatique…"));
    const panel = (await screen.findByText("Le son est coupé, nouvelle tentative automatique")).closest("[role=alert]") as HTMLElement;
    expect(within(panel).getByText(/Micro « Shure MV7 \(USB\) »/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Ouvrir le dossier des journaux" }));
    expect(callsOf("open_logs_folder")).toHaveLength(1);

    act(() => (backend as MockBackend).simulateRecovery());
    expect(await screen.findByText("Son rétabli.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Le son est coupé, nouvelle tentative automatique")).not.toBeInTheDocument());
    expect(screen.queryAllByText(/moteur arrêté/)).toHaveLength(0);
  });

  it("updates the outage reason quietly when a retry identifies the failing device", async () => {
    const { backend } = renderApp("settings");
    await screen.findByText(/Latence mesurée/);
    act(() => (backend as MockBackend).simulateDeviceLoss("Un périphérique audio a été déconnecté. Nouvelle tentative automatique…"));
    await screen.findByText("Le son est coupé, nouvelle tentative automatique");
    act(() => (backend as MockBackend).simulateRetryFailure("Casque « Arctis 7 » : périphérique introuvable. Nouvelle tentative automatique…"));
    const panel = (await screen.findByText(/Casque « Arctis 7 »/)).closest("[role=alert]") as HTMLElement;
    expect(within(panel).queryByText(/a été déconnecté/)).not.toBeInTheDocument();
    expect(screen.queryAllByText(/Casque « Arctis 7 » : périphérique introuvable/).filter((n) => !panel.contains(n))).toHaveLength(0);
  });

  it("reads the engine status again once it listens, so a restart during startup is not missed", async () => {
    const backend = createMockBackend({ meters: false });
    const listen = backend.listen.bind(backend);
    vi.spyOn(backend, "listen").mockImplementation(((name: never, handler: never) =>
      {
        // The engine stops while the UI is still subscribing: its event is missed.
        if ((name as string) === "engine") (backend as MockBackend).simulateDeviceLoss("Micro absent. Nouvelle tentative automatique…");
        return listen(name, handler);
      }) as typeof backend.listen);
    render(
      <VoxProvider backend={backend}>
        <App initialScreen="settings" />
      </VoxProvider>,
    );
    expect(await screen.findByText("Le son est coupé, nouvelle tentative automatique")).toBeInTheDocument();
  });

  it("toggles the options that left the bottom bar", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("settings");
    await user.click(await screen.findByRole("switch", { name: /Mode push-to-talk/ }));
    expect(callsOf("update_settings").at(-1)?.args).toEqual({ patch: { pttMode: true } });
    await user.click(screen.getByRole("switch", { name: /Anti-bruit/ }));
    expect(callsOf("update_settings").at(-1)?.args).toEqual({ patch: { noiseSuppression: false } });
    await user.click(screen.getByRole("switch", { name: /Démarrer réduit/ }));
    expect(callsOf("update_settings").at(-1)?.args).toEqual({ patch: { startMinimized: true } });
  });

  it("sets the two soundboard volumes", async () => {
    const { callsOf } = renderApp("settings");
    fireEvent.change(await screen.findByRole("slider", { name: "Vers le micro" }), { target: { value: "0.4" } });
    await waitFor(() => expect(callsOf("update_settings").at(-1)?.args).toEqual({ patch: { soundMicVolume: 0.4 } }));
    fireEvent.change(screen.getByRole("slider", { name: "Dans mon casque" }), { target: { value: "0.25" } });
    await waitFor(() => expect(callsOf("update_settings").at(-1)?.args).toEqual({ patch: { soundMonitorVolume: 0.25 } }));
    expect(screen.getByText("25 %")).toBeInTheDocument();
  });

  it("shows the AI backend and opens the logs folder from À propos", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("settings");
    expect(await screen.findByText("NVIDIA GeForce RTX 4070")).toBeInTheDocument();
    const about = screen.getByRole("region", { name: "À propos" });
    await user.click(within(about).getByRole("button", { name: "Ouvrir le dossier des journaux" }));
    expect(callsOf("open_logs_folder")).toHaveLength(1);
  });

  it("says when the system defaults are used meanwhile, even if the startup notice was missed", async () => {
    const { backend } = renderApp("settings");
    await screen.findByText(/Latence mesurée/);
    act(() => (backend as MockBackend).simulateFallback("Microphone (Realtek)"));
    expect(await screen.findByText(/Tes périphériques choisis sont indisponibles/)).toHaveTextContent("Microphone (Realtek)");
  });

  it("names the devices the engine really uses", async () => {
    const { backend } = renderApp("settings");
    const snap = await backend.invoke("get_snapshot", {});
    const list = await screen.findByLabelText("Périphériques du moteur audio");
    expect(list).toHaveTextContent(snap.status.inputName ?? "Par défaut du système");
    expect(list).toHaveTextContent(snap.status.cableName ?? "CABLE Input");
  });

  it("names the headset really in use, even on the system default", async () => {
    const { backend } = renderApp("settings");
    const list = await screen.findByLabelText("Périphériques du moteur audio");
    expect(list).toHaveTextContent("Casque (Arctis 7)");
    act(() =>
      backend.simulateExternalChange((s) => {
        s.status = { ...s.status, fallback: true, monitorName: "Haut-parleurs (Realtek)", revision: s.status.revision + 1 };
      }),
    );
    expect(await within(list).findByText("Haut-parleurs (Realtek)")).toBeInTheDocument();
  });

  it("keeps showing the engine's devices while it is stopped and restarting", async () => {
    const { backend } = renderApp("settings");
    await screen.findByLabelText("Périphériques du moteur audio");
    act(() => (backend as MockBackend).simulateDeviceLoss("Micro absent. Nouvelle tentative automatique…"));
    expect(await screen.findByText("Derniers périphériques utilisés")).toBeInTheDocument();
    const list = screen.getByLabelText("Périphériques du moteur audio");
    expect(list).toHaveTextContent("Shure MV7 (USB)");
    expect(list).toHaveTextContent("CABLE Input (VB-Audio Virtual Cable)");
    expect(list).toHaveTextContent("Casque (Arctis 7)");
  });

  it("keeps showing the engine's devices when the device list cannot be read", async () => {
    const backend = createMockBackend({ meters: false });
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) =>
      cmd === "list_devices" ? Promise.reject(new Error("WASAPI indisponible")) : invoke(cmd as never, args as never)) as typeof backend.invoke);
    render(
      <VoxProvider backend={backend}>
        <App initialScreen="settings" />
      </VoxProvider>,
    );
    expect(await screen.findByText("Liste des périphériques indisponible")).toBeInTheDocument();
    expect(screen.getByLabelText("Périphériques du moteur audio")).toHaveTextContent("Shure MV7 (USB)");
  });

  it("shows only the outage cause when the engine never opened a device", async () => {
    const { backend } = renderApp("settings");
    await screen.findByLabelText("Périphériques du moteur audio");
    act(() =>
      backend.simulateExternalChange((s) => {
        s.status = {
          ...s.status,
          running: false,
          restarting: true,
          inputName: null,
          cableName: null,
          monitorName: null,
          lastError: "Aucun micro trouvé au démarrage. Nouvelle tentative automatique…",
          revision: s.status.revision + 1,
        };
      }),
    );
    expect(await screen.findByText(/Aucun micro trouvé au démarrage/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Périphériques du moteur audio")).not.toBeInTheDocument();
    expect(screen.queryByText("Derniers périphériques utilisés")).not.toBeInTheDocument();
  });

  it("says when no headset is open", async () => {
    const { backend } = renderApp("settings");
    const list = await screen.findByLabelText("Périphériques du moteur audio");
    act(() =>
      backend.simulateExternalChange((s) => {
        s.status = { ...s.status, monitorName: null, revision: s.status.revision + 1 };
      }),
    );
    expect(await within(list).findByText("Aucun casque ouvert")).toBeInTheDocument();
  });

  it("ignores an older settings answer that arrives after a newer one", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("settings");
    const invoke = backend.invoke.bind(backend);
    let releaseFirst: () => void = () => {};
    let calls = 0;
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "update_settings" && ++calls === 1) {
        // Committed now (the backend captured its answer), delivered late.
        const answer = invoke("update_settings", args as never);
        return new Promise((r) => (releaseFirst = () => r(answer)));
      }
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("switch", { name: /Anti-bruit/ }));
    await user.click(screen.getByRole("switch", { name: /Mode push-to-talk/ }));
    await waitFor(() => expect(screen.getByRole("switch", { name: /Mode push-to-talk/ })).toBeChecked());
    await act(async () => releaseFirst());
    expect(screen.getByRole("switch", { name: /Mode push-to-talk/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Anti-bruit/ })).not.toBeChecked();
  });

  it("offers the RVC settings even before any AI voice is opened", async () => {
    const { callsOf } = renderApp("settings");
    const pitch = await screen.findByRole("slider", { name: "Hauteur" });
    fireEvent.change(pitch, { target: { value: "-4" } });
    await waitFor(() =>
      expect(callsOf("update_settings").at(-1)?.args).toMatchObject({ patch: { aiParams: { pitchSemitones: -4 } } }),
    );
  });

  it("explains a missing VB-Cable", async () => {
    renderApp("settings", { cableMissing: true });
    expect(await screen.findByText("VB-Cable est introuvable")).toBeInTheDocument();
    expect(screen.getByText(/Relance l'installateur/)).toBeInTheDocument();
  });

  it("captures a global hotkey and sends it with set_hotkey", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("settings");
    const capture = await screen.findByRole("button", { name: /^Raccourci pour Stopper les sons :/ });
    await user.click(capture);
    fireEvent.keyDown(capture, { code: "F9", key: "F9" });
    await waitFor(() =>
      expect(callsOf("set_hotkey").at(-1)?.args).toEqual({ action: { type: "stopAllSounds" }, accelerator: "F9" }),
    );
    expect(capture).toHaveTextContent("F9");
  });
});
