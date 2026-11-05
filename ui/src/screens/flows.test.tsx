import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import type { MockBackend } from "../ipc/mock";
import { SEARCH_DEBOUNCE_MS } from "./sounds/Explorer";
import { BUILTIN_PRESETS } from "../ipc/generated/presets";

afterEach(() => vi.useRealTimers());

describe("voice selection", () => {
  it("activates a voice on click and reflects it in the grid and the bottom bar", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    const robot = await screen.findByRole("button", { name: /Robot/ });
    expect(robot).toHaveAttribute("aria-pressed", "false");
    await user.click(robot);
    expect(callsOf("set_active_voice")).toEqual([{ cmd: "set_active_voice", args: { id: "robot" } }]);
    expect(robot).toHaveAttribute("aria-pressed", "true");
    expect(within(robot).getByText("Active")).toBeInTheDocument();
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("Robot")).toBeInTheDocument();
    expect(within(footer).getByText(/voix active · Ctrl\+Alt\+2/)).toBeInTheDocument();
  });

  it("filters by category and search", async () => {
    const user = userEvent.setup();
    renderApp("voices");
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    const cards = () => within(screen.getByRole("list", { name: "Voix disponibles" })).getAllByRole("listitem");
    expect(cards()).toHaveLength(2);
    await user.click(screen.getByRole("radio", { name: "Toutes" }));
    expect(cards()).toHaveLength(25);
    await user.type(screen.getByRole("searchbox", { name: "Rechercher une voix" }), "cathedrale");
    expect(cards()).toHaveLength(1);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText(/Aucune voix ne correspond/)).toBeInTheDocument();
  });

  it("follows hotkey-driven changes pushed through snapshot-changed", async () => {
    const { backend } = renderApp("voices");
    await screen.findByRole("button", { name: /Extraterrestre/ });
    act(() => backend.simulateExternalChange((s) => (s.settings.activeVoiceId = "alien")));
    expect(screen.getByRole("button", { name: /Extraterrestre/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles the voice changer from the bottom bar", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    await user.click(await screen.findByRole("button", { name: "Voix activée" }));
    expect(screen.getByRole("button", { name: "Voix coupée" })).toHaveAttribute("aria-pressed", "false");
    expect(callsOf("update_settings").at(-1)?.args).toEqual({ patch: { voiceEnabled: false } });
  });
});

describe("sound edit flow", () => {
  it("renames, loops and binds a hotkey, then saves through update_sound + set_hotkey", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("button", { name: "Modifier Oof" }));
    const panel = screen.getByRole("complementary", { name: "Modifier le son" });
    const name = within(panel).getByLabelText("Nom");
    await user.clear(name);
    await user.type(name, "Oof Roblox");
    await user.click(within(panel).getByRole("switch", { name: /Lecture en boucle/ }));
    const capture = within(panel).getByRole("button", { name: /Raccourci pour Oof/ });
    await user.click(capture);
    fireEvent.keyDown(capture, { code: "KeyO", key: "o", ctrlKey: true, altKey: true });
    expect(capture).toHaveTextContent("Ctrl+Alt+O");
    await user.click(within(panel).getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(callsOf("update_sound")).toHaveLength(1));
    expect(callsOf("update_sound")[0]?.args).toMatchObject({
      sound: { id: "snd-oof", name: "Oof Roblox", loop: true, hotkey: "Ctrl+Alt+O" },
    });
    await waitFor(() =>
      expect(callsOf("set_hotkey")[0]?.args).toEqual({ action: { type: "sound", id: "snd-oof" }, accelerator: "Ctrl+Alt+O" }),
    );
    expect(await screen.findByRole("button", { name: "Jouer Oof Roblox" })).toHaveTextContent("Ctrl+Alt+O");
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

  it("imports dropped files", async () => {
    const { backend, callsOf } = renderApp("sounds");
    await screen.findByRole("button", { name: "Jouer Oof" });
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
    await user.click(await screen.findByRole("tab", { name: "Explorer MyInstants" }));
    await screen.findByRole("button", { name: "Écouter Vine boom" });
    await user.type(screen.getByRole("searchbox", { name: "Rechercher sur MyInstants" }), "bruh");
    expect(callsOf("myinstants_search")).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10));
    expect(callsOf("myinstants_search")).toEqual([{ cmd: "myinstants_search", args: { query: "bruh", page: 1 } }]);
    expect(await screen.findByRole("button", { name: "Écouter Bruh" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Écouter Vine boom" })).not.toBeInTheDocument();
  });

  it("shows a recoverable error when MyInstants is unreachable", async () => {
    const user = userEvent.setup();
    renderApp("sounds", { myinstantsOffline: true });
    await user.click(await screen.findByRole("tab", { name: "Explorer MyInstants" }));
    expect(await screen.findByText("MyInstants est injoignable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeInTheDocument();
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
    await user.click(await screen.findByRole("tab", { name: "Explorer MyInstants" }));
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
    await user.click(await screen.findByRole("tab", { name: "Explorer MyInstants" }));
    const tile = (await screen.findByRole("button", { name: "Écouter Tuturu" })).closest("[role=listitem]") as HTMLElement;
    await user.click(within(tile).getByRole("button", { name: /Ajouter/ }));
    await user.selectOptions(within(tile).getByLabelText("Catégorie"), "Mèmes");
    await user.click(within(tile).getByRole("button", { name: "Ajouter" }));
    expect(await within(tile).findByText("Dans ta banque")).toBeInTheDocument();
    expect(callsOf("myinstants_add")[0]?.args).toMatchObject({ sound: { title: "Tuturu" }, category: "Mèmes" });
  });
});

describe("editor", () => {
  it("duplicates a built-in voice, previews live, saves, and clears the preview on leave", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("editor");
    const robotPreset = BUILTIN_PRESETS.find((v) => v.id === "robot");
    if (!robotPreset) throw new Error("robot preset missing");
    await user.click(await screen.findByRole("button", { name: "Dupliquer Robot" }));
    expect(screen.getByLabelText("Nom")).toHaveValue("Robot (copie)");
    await waitFor(() =>
      expect(callsOf("preview_effects").at(-1)?.args).toMatchObject({ effects: robotPreset.effects }),
    );
    await user.click(screen.getByRole("button", { name: "Créer la voix" }));
    await waitFor(() => expect(callsOf("save_voice")).toHaveLength(1));
    expect(callsOf("save_voice")[0]?.args).toMatchObject({ voice: { id: "", name: "Robot (copie)", builtin: false } });
    await user.click(screen.getByRole("button", { name: "Voix" }));
    expect(callsOf("preview_effects").at(-1)?.args).toEqual({ effects: null });
  });

  it("clamps slider input to the descriptor range", async () => {
    renderApp("editor");
    const slider = (await screen.findAllByRole("slider", { name: "Demi-tons" }))[0] as HTMLInputElement;
    // Real catalog: semitones in [-12, 12], step 0.1.
    fireEvent.change(slider, { target: { value: "3.34" } });
    expect(slider.value).toBe("3.3");
    fireEvent.change(slider, { target: { value: "3.36" } });
    expect(slider.value).toBe("3.4");
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
    expect(await screen.findByText(/\d+ ms/)).toBeInTheDocument();
    act(() => (backend as MockBackend).simulateDeviceLoss("Le périphérique audio a été déconnecté"));
    expect(await screen.findByText(/a été déconnecté/)).toBeInTheDocument();
    expect(await screen.findAllByText(/moteur arrêté/)).not.toHaveLength(0);
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
