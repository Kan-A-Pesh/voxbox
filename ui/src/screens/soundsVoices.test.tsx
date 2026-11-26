import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";

describe("MyInstants: play to everyone, or preview in the headset", () => {
  it("plays through the engine to everyone, and stops on a second click", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await user.click(await screen.findByRole("button", { name: "Jouer Vine boom" }));
    await waitFor(() => expect(callsOf("myinstants_play")).toHaveLength(1));
    expect(callsOf("myinstants_play")[0]?.args).toMatchObject({ sound: { title: "Vine boom" }, preview: false });
    const stop = await screen.findByRole("button", { name: "Arrêter Vine boom" });
    await user.click(stop);
    await waitFor(() => expect(callsOf("stop_sound").at(-1)?.args).toMatchObject({ id: expect.stringMatching(/^myinstants:/) }));
    expect(await screen.findByRole("button", { name: "Jouer Vine boom" })).toBeInTheDocument();
  });

  it("previews in the headset only, then switches to everyone when played", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await user.click(await screen.findByRole("button", { name: "Aperçu de Vine boom (casque seulement)" }));
    await waitFor(() => expect(callsOf("myinstants_play")[0]?.args).toMatchObject({ preview: true }));
    const stopPreview = await screen.findByRole("button", { name: "Arrêter l'aperçu de Vine boom" });
    expect(stopPreview).toHaveAttribute("aria-pressed", "true");
    // Playing it for everyone restarts it in the other mode.
    await user.click(screen.getByRole("button", { name: "Jouer Vine boom" }));
    await waitFor(() => expect(callsOf("myinstants_play")[1]?.args).toMatchObject({ preview: false }));
    expect(await screen.findByRole("button", { name: "Arrêter Vine boom" })).toBeInTheDocument();
  });

  it("a play still downloading when leaving MyInstants never starts", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds", { remoteDownloadMs: 300 });
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await user.click(await screen.findByRole("button", { name: "Jouer Vine boom" }));
    await waitFor(() => expect(callsOf("myinstants_play")).toHaveLength(1));
    await user.click(screen.getByRole("tab", { name: /Ma banque/ }));
    // Leaving stops it: still downloading, it is cancelled and never starts.
    expect(callsOf("stop_sound").map((c) => (c.args as { id: string }).id)).toEqual([expect.stringMatching(/^myinstants:.*#1$/)]);
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByRole("button", { name: "Tout arrêter" })).toBeDisabled();
  });

  it("switching mode before any progress event stops the first playback", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    const plays: unknown[] = [];
    // The real engine reports progress a few blocks later: here, never.
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) =>
      cmd === "myinstants_play"
        ? Promise.resolve(`silent#${plays.push(args)}`)
        : invoke(cmd as never, args as never)) as typeof backend.invoke);
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await user.click(await screen.findByRole("button", { name: "Jouer Vine boom" }));
    expect(await screen.findByRole("button", { name: "Arrêter Vine boom" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Aperçu de Vine boom (casque seulement)" }));
    // One request stops the old playback and starts the new one: a "Tout arrêter"
    // clicked meanwhile reaches the app after it and cancels both.
    await waitFor(() => expect(plays[1]).toMatchObject({ preview: true, replace: "silent#1" }));
    expect(callsOf("stop_sound")).toHaveLength(0);
    expect(await screen.findByRole("button", { name: "Arrêter l'aperçu de Vine boom" })).toBeInTheDocument();
  });

  it("sound commands go one at a time: a Tout arrêter waits for the play clicked before it", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    const sent: string[] = [];
    let release: () => void = () => {};
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      sent.push(cmd);
      if (cmd !== "myinstants_play") return invoke(cmd as never, args as never);
      return new Promise((resolve) => (release = () => resolve(invoke(cmd as never, args as never))));
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await user.click(await screen.findByRole("button", { name: "Jouer Vine boom" }));
    const stopAll = screen.getByRole("button", { name: "Tout arrêter" });
    await waitFor(() => expect(stopAll).toBeEnabled());
    await user.click(stopAll);
    // Not sent while the play is unanswered: it can never overtake it.
    expect(sent).not.toContain("stop_all_sounds");
    release();
    await waitFor(() => expect(sent).toContain("stop_all_sounds"));
    expect(sent.indexOf("myinstants_play")).toBeLessThan(sent.indexOf("stop_all_sounds"));
    expect(await screen.findByRole("button", { name: "Jouer Vine boom" })).toBeInTheDocument();
  });

  it("says why a sound cannot be played, and lets it be tried again", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("sounds", { remoteDownloadMs: 10_000 });
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await user.click(await screen.findByRole("button", { name: "Jouer Vine boom" }));
    await waitFor(() => expect(callsOf("myinstants_play")).toHaveLength(1));
    // The download fails after the app accepted the play.
    backend.simulateSoundFailed(`myinstants:${(callsOf("myinstants_play")[0]?.args as { sound: { mp3Url: string } }).sound.mp3Url}#1`, "téléchargement impossible");
    expect(await screen.findByText("téléchargement impossible")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jouer Vine boom" })).toBeEnabled();
  });

  it("a second click while switching mode starts a single play", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    let release: () => void = () => {};
    let plays = 0;
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd !== "myinstants_play" || ++plays === 1) return invoke(cmd as never, args as never);
      return new Promise((resolve) => (release = () => resolve(invoke(cmd as never, args as never))));
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await user.click(await screen.findByRole("button", { name: "Jouer Vine boom" }));
    const preview = await screen.findByRole("button", { name: "Aperçu de Vine boom (casque seulement)" });
    await user.click(preview);
    await waitFor(() => expect(plays).toBe(2));
    // The tile is locked while the switch is under way.
    expect(preview).toBeDisabled();
    preview.click();
    release();
    expect(await screen.findByRole("button", { name: "Arrêter l'aperçu de Vine boom" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(plays).toBe(2);
  });

  it("a playback that ends before its command answers leaves the tile ready to play", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    let n = 0;
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd !== "myinstants_play") return invoke(cmd as never, args as never);
      const url = (args as { sound: { mp3Url: string } }).sound.mp3Url;
      if (n > 0) return invoke(cmd as never, args as never).then(() => `myinstants:${url}#late${++n}`);
      const id = `myinstants:${url}#early${++n}`;
      // The engine says it ended (no free voice) before the command answers.
      backend.simulateSoundEnded(id);
      return Promise.resolve(id);
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    await user.click(await screen.findByRole("button", { name: "Jouer Vine boom" }));
    await waitFor(() => expect(n).toBe(1));
    const play = await screen.findByRole("button", { name: "Jouer Vine boom" });
    expect(play).toBeEnabled();
    await user.click(play);
    await waitFor(() => expect(n).toBe(2));
    expect(callsOf("stop_sound")).toHaveLength(0);
  });


  it("Tout arrêter is available while a lone sound downloads, and cancels it", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds", { remoteDownloadMs: 300 });
    await user.click(await screen.findByRole("tab", { name: "MyInstants" }));
    const stopAll = screen.getByRole("button", { name: "Tout arrêter" });
    expect(stopAll).toBeDisabled();
    await user.click(await screen.findByRole("button", { name: "Jouer Vine boom" }));
    await waitFor(() => expect(stopAll).toBeEnabled());
    await user.click(stopAll);
    expect(callsOf("stop_all_sounds")).toHaveLength(1);
    // Cancelled while it downloaded: the tile is ready again and the sound never starts.
    expect(await screen.findByRole("button", { name: "Jouer Vine boom" })).toBeEnabled();
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByRole("button", { name: "Jouer Vine boom" })).toBeInTheDocument();
    expect(stopAll).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stars a voice: it moves first in Toutes and is listed in Favoris", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices");
    const list = await screen.findByRole("list", { name: "Voix disponibles" });
    const cards = () => within(list).getAllByRole("listitem");
    const last = cards().at(-1)!;
    const label = within(last).getByRole("button", { name: /^Ajouter .* aux favoris$/ }).getAttribute("aria-label")!;
    const voiceName = label.replace(/^Ajouter /, "").replace(/ aux favoris$/, "");
    await user.click(within(last).getByRole("button", { name: label }));
    await waitFor(() => expect(callsOf("set_voice_favorite").at(-1)?.args).toMatchObject({ favorite: true }));
    await waitFor(() => expect(within(cards()[0]!).getByRole("button", { name: `Retirer ${voiceName} des favoris` })).toBeInTheDocument());

    await user.click(screen.getByRole("radio", { name: "Favoris" }));
    expect(cards()).toHaveLength(1);
    await user.click(within(cards()[0]!).getByRole("button", { name: `Retirer ${voiceName} des favoris` }));
    expect(await screen.findByText(/Aucune voix favorite/)).toBeInTheDocument();
  });

  it("stars are saved one at a time: a late answer never hides a newer star, star then unstar ends unstarred", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    const sent: { id: string; favorite: boolean }[] = [];
    let release: () => void = () => {};
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd !== "set_voice_favorite") return invoke(cmd as never, args as never);
      sent.push(args as { id: string; favorite: boolean });
      // Saved at once, answered late (the first one only).
      const saved = invoke(cmd as never, args as never);
      return sent.length > 1 ? saved : new Promise((resolve) => (release = () => resolve(saved)));
    }) as typeof backend.invoke);
    const list = await screen.findByRole("list", { name: "Voix disponibles" });
    const labels = within(list)
      .getAllByRole("button", { name: /^Ajouter .* aux favoris$/ })
      .slice(-2)
      .map((star) => star.getAttribute("aria-label") ?? "");
    const [b = "", a = ""] = labels;
    const unstar = (label: string) => label.replace(/^Ajouter (.*) aux favoris$/, "Retirer $1 des favoris");
    await user.click(within(list).getByRole("button", { name: a }));
    await user.click(within(list).getByRole("button", { name: b }));
    await user.click(within(list).getByRole("button", { name: unstar(a) }));
    // Waiting for the first answer before sending the next.
    expect(sent).toHaveLength(1);
    release();
    await waitFor(() => expect(sent).toHaveLength(3));
    await waitFor(async () => expect((await invoke("get_snapshot", {})).settings.favoriteVoiceIds).toHaveLength(1));
    expect(await within(list).findByRole("button", { name: unstar(b) })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: a })).toBeInTheDocument();
  });

  it("star then unstar of one voice around a pushed snapshot ends unstarred", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    const sent: { id: string; favorite: boolean }[] = [];
    let release: () => void = () => {};
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd !== "set_voice_favorite") return invoke(cmd as never, args as never);
      sent.push(args as { id: string; favorite: boolean });
      if (sent.length > 1) return invoke(cmd as never, args as never);
      return new Promise((resolve) => (release = () => resolve(invoke(cmd as never, args as never))));
    }) as typeof backend.invoke);
    const list = await screen.findByRole("list", { name: "Voix disponibles" });
    const star = within(list).getAllByRole("button", { name: /^Ajouter .* aux favoris$/ }).at(-1)?.getAttribute("aria-label") ?? "";
    const unstar = star.replace(/^Ajouter (.*) aux favoris$/, "Retirer $1 des favoris");
    await user.click(within(list).getByRole("button", { name: star }));
    // A hotkey pushes the app's settings, which do not have that star yet.
    act(() => backend.simulateExternalChange((s) => (s.settings.monitor = !s.settings.monitor)));
    await user.click(within(list).getByRole("button", { name: unstar }));
    release();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((x) => x.favorite)).toEqual([true, false]);
    await waitFor(async () => expect((await invoke("get_snapshot", {})).settings.favoriteVoiceIds).toHaveLength(0));
    expect(within(list).getByRole("button", { name: star })).toBeInTheDocument();
  });

  it("a star waiting for its answer survives a pushed snapshot and the next star", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    const invoke = backend.invoke.bind(backend);
    let release: () => void = () => {};
    let held = true;
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd !== "set_voice_favorite" || !held) return invoke(cmd as never, args as never);
      held = false;
      return new Promise((resolve) => (release = () => resolve(invoke(cmd as never, args as never))));
    }) as typeof backend.invoke);
    const list = await screen.findByRole("list", { name: "Voix disponibles" });
    const [b, a] = within(list)
      .getAllByRole("button", { name: /^Ajouter .* aux favoris$/ })
      .slice(-2)
      .map((star) => star.getAttribute("aria-label")!);
    await user.click(within(list).getByRole("button", { name: a }));
    // A hotkey pushes the app's settings, which do not have the first star yet.
    act(() => backend.simulateExternalChange((s) => (s.settings.monitor = !s.settings.monitor)));
    await user.click(within(list).getByRole("button", { name: b }));
    release();
    await waitFor(async () => expect((await invoke("get_snapshot", {})).settings.favoriteVoiceIds).toHaveLength(2));
    await waitFor(() => expect(within(list).getAllByRole("button", { name: /^Retirer .* des favoris$/ })).toHaveLength(2));
  });
});

describe("sound editor and pad", () => {
  it("saving the open editor keeps a loop toggled on the pad meanwhile", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("sounds");
    await user.click(await screen.findByRole("button", { name: "Modifier Oof" }));
    await user.click(screen.getByRole("button", { name: "Jouer Oof en boucle" }));
    await waitFor(() => expect(callsOf("update_sound")).toHaveLength(1));
    const panel = screen.getByRole("complementary", { name: "Modifier le son" });
    await user.click(within(panel).getByRole("radio", { name: "#ff9f1c" }));
    await user.click(within(panel).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(callsOf("update_sound")).toHaveLength(2));
    expect(callsOf("update_sound")[1]?.args).toMatchObject({ sound: { id: "snd-oof", loop: true, color: "#ff9f1c" } });
  });

  it("a play clicked before the stop-all shortcut, still queued, never starts", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    const plays: { id: string; stops: number }[] = [];
    let release: () => void = () => {};
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd !== "play_sound") return invoke(cmd as never, args as never);
      plays.push(args as { id: string; stops: number });
      if (plays.length > 1) return invoke(cmd as never, args as never);
      return new Promise((resolve) => (release = () => resolve(invoke(cmd as never, args as never))));
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: "Jouer Oof" }));
    await user.click(screen.getByRole("button", { name: "Jouer Bruh" }));
    // The shortcut runs while Bruh still waits behind Oof's unanswered play.
    act(() => backend.simulateHotkeyStopAll());
    release();
    await waitFor(() => expect(plays).toHaveLength(2));
    expect(plays[1]).toMatchObject({ id: "snd-bruh", stops: 0 });
    expect(await screen.findByRole("button", { name: "Jouer Bruh" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("button", { name: "Jouer Bruh" })).toBeInTheDocument();
  });

  it("a bank play the app could not start (engine stopped) leaves the pad ready, with the reason", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) =>
      cmd === "play_sound" ? Promise.resolve(null) : invoke(cmd as never, args as never)) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: "Jouer Oof" }));
    expect(await screen.findByRole("button", { name: "Arrêter Oof" })).toBeInTheDocument();
    act(() => backend.simulateSoundFailed("snd-oof", "le moteur audio est arrêté : redémarre VoxBox"));
    expect(await screen.findByText("le moteur audio est arrêté : redémarre VoxBox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jouer Oof" })).toBeInTheDocument();
  });

  it("a pad still decoding counts as playing: Tout arrêter works and a second click stops it", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    // The app accepted the play and decodes the file: no progress yet.
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) =>
      cmd === "play_sound" ? Promise.resolve(null) : invoke(cmd as never, args as never)) as typeof backend.invoke);
    const stopAll = await screen.findByRole("button", { name: "Tout arrêter" });
    expect(stopAll).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Jouer Oof" }));
    expect(await screen.findByRole("button", { name: "Arrêter Oof" })).toBeInTheDocument();
    expect(stopAll).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Arrêter Oof" }));
    await waitFor(() => expect(callsOf("stop_sound").at(-1)?.args).toMatchObject({ id: "snd-oof" }));
    // The app ends a cancelled play for the UI.
    act(() => backend.simulateSoundEnded("snd-oof"));
    expect(await screen.findByRole("button", { name: "Jouer Oof" })).toBeInTheDocument();
    expect(stopAll).toBeDisabled();
  });

  it("a loop toggled while the editor saves is sent after it, and both are kept", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    let release: () => void = () => {};
    const sent: unknown[] = [];
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd !== "update_sound") return invoke(cmd as never, args as never);
      sent.push(args);
      if (sent.length > 1) return invoke(cmd as never, args as never);
      return new Promise((resolve) => (release = () => resolve(invoke(cmd as never, args as never))));
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: "Modifier Oof" }));
    const panel = screen.getByRole("complementary", { name: "Modifier le son" });
    await user.click(within(panel).getByRole("radio", { name: "#ff9f1c" }));
    await user.click(within(panel).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Jouer Oof en boucle" }));
    // Queued behind the editor's save, not racing it.
    expect(sent).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ne plus jouer Oof en boucle" })).toBeInTheDocument();
    release();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toMatchObject({ sound: { id: "snd-oof", loop: false, color: "#ff9f1c" } });
    expect(sent[1]).toMatchObject({ sound: { id: "snd-oof", loop: true, color: "#ff9f1c" } });
    // The editor's answer, older than the loop change, never hides it.
    expect(await screen.findByRole("button", { name: "Ne plus jouer Oof en boucle" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole("button", { name: "Ne plus jouer Oof en boucle" })).toBeInTheDocument();
  });

  it("a write held while switching tabs still comes before a later one", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("sounds");
    const invoke = backend.invoke.bind(backend);
    let release: () => void = () => {};
    const sent: unknown[] = [];
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd !== "update_sound") return invoke(cmd as never, args as never);
      sent.push(args);
      if (sent.length > 1) return invoke(cmd as never, args as never);
      return new Promise((resolve) => (release = () => resolve(invoke(cmd as never, args as never))));
    }) as typeof backend.invoke);
    await user.click(await screen.findByRole("button", { name: "Modifier Oof" }));
    const panel = screen.getByRole("complementary", { name: "Modifier le son" });
    await user.click(within(panel).getByRole("radio", { name: "#ff9f1c" }));
    await user.click(within(panel).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await user.click(screen.getByRole("tab", { name: "MyInstants" }));
    await user.click(screen.getByRole("tab", { name: /Ma banque/ }));
    await user.click(await screen.findByRole("button", { name: "Jouer Oof en boucle" }));
    expect(sent).toHaveLength(1);
    release();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ sound: { id: "snd-oof", loop: true, color: "#ff9f1c" } });
    expect(await screen.findByRole("button", { name: "Ne plus jouer Oof en boucle" })).toBeInTheDocument();
  });

  it("colors are radios: arrows move and select, one tab stop", async () => {
    const user = userEvent.setup();
    renderApp("sounds");
    await user.click(await screen.findByRole("button", { name: "Modifier Oof" }));
    const group = screen.getByRole("radiogroup", { name: "Couleur du son" });
    const none = within(group).getByRole("radio", { name: "Sans couleur" });
    expect(none).toHaveAttribute("aria-checked", "true");
    expect(within(group).getAllByRole("radio").filter((r) => r.tabIndex === 0)).toEqual([none]);
    none.focus();
    await user.keyboard("{ArrowRight}");
    const first = within(group).getAllByRole("radio")[1]!;
    expect(first).toHaveAttribute("aria-checked", "true");
    expect(first).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(within(group).getAllByRole("radio").at(-1)).toHaveAttribute("aria-checked", "true");
  });
});
