import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { AI_PACK_DISMISSED_KEY, AI_PACK_PENDING_KEY } from "../state/aiPack";
import { setRunning } from "./voices/aiImportRunning";
import { isPackInstalling, setPackInstalling } from "../state/packInstalling";

afterEach(() => {
  window.localStorage.clear();
  setRunning(null);
  setPackInstalling(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const UPDATE = { version: 15, size: 790_000_000 };
const OLD_PACK = { installed: true, version: null, onlineReady: false };
const NO_PACK = { installed: false, version: null, onlineReady: false };
const packDialog = () => screen.findByRole("dialog", { name: "Pack Voix IA 15 disponible" });

describe("Voix IA pack updates", () => {
  it("offers a newer pack at launch once per version, then only the banner", async () => {
    const user = userEvent.setup();
    const first = renderApp("voices", { aiPackUpdate: UPDATE });
    const pop = await packDialog();
    expect(within(pop).getByText(/Tu as le pack 14\. VoxBox télécharge le pack \(790 Mo\)/)).toBeInTheDocument();
    expect(within(pop).getByRole("button", { name: "Mettre à jour le pack" })).toHaveFocus();

    await user.click(within(pop).getByRole("button", { name: "Plus tard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Pack Voix IA 15 disponible.")).toBeInTheDocument();
    expect(window.localStorage.getItem(AI_PACK_DISMISSED_KEY)).toBe("15");
    first.unmount();

    // Next launch: same pack, no pop-up, the banner is back.
    renderApp("voices", { aiPackUpdate: UPDATE });
    expect(await screen.findByText("Pack Voix IA 15 disponible.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays quiet at launch without a newer pack, or without any pack installed", async () => {
    const quiet = renderApp("voices");
    await waitFor(() => expect(quiet.callsOf("ai_pack_check")).toHaveLength(1));
    expect(screen.queryByText(/Pack Voix IA \d+ disponible/)).toBeNull();
    quiet.unmount();

    // The pack is optional: no pop-up nor banner when it is not installed.
    const none = renderApp("voices", { aiPack: NO_PACK, aiPackUpdate: UPDATE });
    await waitFor(() => expect(none.callsOf("ai_pack_check")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/Pack Voix IA 15/)).toBeNull();
  });

  it("lets the app's own update pop-up go first", async () => {
    const user = userEvent.setup();
    renderApp("voices", { update: { version: "0.1.42" }, aiPackUpdate: UPDATE });
    const app = await screen.findByRole("dialog", { name: /VoxBox 0\.1\.42 est disponible/ }, { timeout: 5000 });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(within(app).getByRole("button", { name: "Plus tard" }));
    expect(await packDialog()).toBeInTheDocument();
  });

  it("keeps the pack install in front of an app update found meanwhile, and refuses that update", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("voices", { aiPackUpdate: UPDATE });
    // The app's own check answers only once the pack install has started.
    const release = backend.holdUpdateChecks();
    backend.setUpdate({ version: "0.1.42" });
    await user.click(within(await packDialog()).getByRole("button", { name: "Mettre à jour le pack" }));
    expect(isPackInstalling()).toBe(true);
    act(() => release());
    await waitFor(() => expect(backend.updateChecks()).toBeGreaterThan(0));
    await act(async () => {});
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Mise à jour du pack Voix IA 15" })).toBeInTheDocument();
    expect(callsOf("ai_pack_install")).toHaveLength(1);
  });

  it("refuses an app update install while the pack is being installed", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices", { update: { version: "0.1.42" } });
    const app = await screen.findByRole("dialog", { name: /VoxBox 0\.1\.42 est disponible/ }, { timeout: 5000 });
    await user.click(within(app).getByRole("button", { name: "Plus tard" }));
    const banner = screen.getByRole("button", { name: "Mettre à jour" });

    act(() => setPackInstalling(true));
    await user.click(banner);
    await act(async () => {});
    expect(backend.restarted()).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => setPackInstalling(false));
    await user.click(screen.getByRole("button", { name: "Mettre à jour" }));
    await waitFor(() => expect(backend.restarted()).toBe(true));
  });

  it("ignores files dropped on the window while the pack pop-up is open", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("sounds", { aiPackUpdate: UPDATE });
    const pop = await packDialog();
    await waitFor(() => expect(backend.hasDropListener()).toBe(true));
    act(() => backend.simulateDrop(["C:\\Sons\\Gong.ogg"]));
    await act(async () => {});
    expect(callsOf("import_sounds")).toHaveLength(0);

    await user.click(within(pop).getByRole("button", { name: "Plus tard" }));
    act(() => backend.simulateDrop(["C:\\Sons\\Gong.ogg"]));
    await waitFor(() => expect(callsOf("import_sounds")).toHaveLength(1));
  });

  it("downloads the pack with progress, then hands over to the installer", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices", { aiPackUpdate: UPDATE });
    await user.click(within(await packDialog()).getByRole("button", { name: "Mettre à jour le pack" }));
    const pop = screen.getByRole("dialog", { name: "Mise à jour du pack Voix IA 15" });
    expect(within(pop).getByRole("progressbar", { name: "Téléchargement du pack Voix IA" })).toBeInTheDocument();
    expect(within(pop).getByRole("button", { name: "Mettre à jour le pack" })).toBeDisabled();
    expect(await within(pop).findByText(/VoxBox se ferme le temps de l’installer/)).toBeInTheDocument();
    expect(callsOf("ai_pack_install").map((c) => c.args)).toEqual([{ version: 15 }]);
    // Checked at the next launch: was it installed?
    expect(window.localStorage.getItem(AI_PACK_PENDING_KEY)).toBe("15");
  });

  it("shows a failed install in the pop-up and allows another try", async () => {
    const user = userEvent.setup();
    renderApp("voices", { aiPackUpdate: UPDATE, aiPackFailWith: "Le pack téléchargé ne correspond pas au pack publié." });
    await user.click(within(await packDialog()).getByRole("button", { name: "Mettre à jour le pack" }));
    const failed = await screen.findByText("La mise à jour du pack n’a pas pu se faire");
    const pop = screen.getByRole("dialog");
    expect(within(pop).getByText(/ne correspond pas au pack publié/)).toBeInTheDocument();
    expect(failed).toBeInTheDocument();
    expect(within(pop).getByRole("button", { name: "Réessayer" })).toBeEnabled();
    expect(window.localStorage.getItem(AI_PACK_PENDING_KEY)).toBeNull();
    expect(isPackInstalling()).toBe(false);
  });

  it("refreshes a superseded offer after a failed install", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("voices", { aiPackUpdate: UPDATE });
    const pop = await packDialog();
    // Pack 16 was published meanwhile: the install of 15 is refused, the offer becomes 16.
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) => {
      if (cmd === "ai_pack_install") return Promise.reject(new Error("le pack 15 n'est plus le dernier publié"));
      if (cmd === "ai_pack_check") return Promise.resolve({ version: 16, size: 800_000_000 });
      return invoke(cmd as never, args as never);
    }) as typeof backend.invoke);
    await user.click(within(pop).getByRole("button", { name: "Mettre à jour le pack" }));
    expect(await screen.findByRole("dialog", { name: "Pack Voix IA 16 disponible" })).toBeInTheDocument();
    expect(callsOf("ai_pack_check").length).toBeGreaterThanOrEqual(1);
  });

  it("refuses to close VoxBox while an AI voice is being imported", async () => {
    const user = userEvent.setup();
    const { callsOf } = renderApp("voices", { aiPackUpdate: UPDATE });
    const pop = await packDialog();
    setRunning({ name: "Vador", progress: 0.3 });
    await user.click(within(pop).getByRole("button", { name: "Mettre à jour le pack" }));
    expect(await within(pop).findByText(/Une voix IA est en cours d’import/)).toBeInTheDocument();
    expect(callsOf("ai_pack_install")).toHaveLength(0);
  });

  it("reports at the next launch whether the pack was installed", async () => {
    window.localStorage.setItem(AI_PACK_PENDING_KEY, "15");
    const refused = renderApp("voices");
    expect(await screen.findByText(/n’a pas été mis à jour : l’installation a été annulée ou refusée/)).toBeInTheDocument();
    expect(window.localStorage.getItem(AI_PACK_PENDING_KEY)).toBeNull();
    refused.unmount();

    window.localStorage.setItem(AI_PACK_PENDING_KEY, "15");
    renderApp("voices", { aiPack: { version: 15 } });
    expect(await screen.findByText("Pack Voix IA 15 installé")).toBeInTheDocument();
  });

  it("hides that report on its own once read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.setItem(AI_PACK_PENDING_KEY, "15");
    renderApp("voices");
    await screen.findByText(/n’a pas été mis à jour/);
    await act(async () => {}); // The toast's own timer starts with its effect.
    // 19 words read at 300 ms each: 5.7 s on screen.
    act(() => vi.advanceTimersByTime(4700));
    expect(screen.getByText(/n’a pas été mis à jour/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.queryByText(/n’a pas été mis à jour/)).toBeNull();
  });

  it("shows the installed pack in Réglages and looks for a newer one when asked", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("settings");
    expect(await screen.findByText("Pack Voix IA")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rechercher une mise à jour du pack" }));
    expect(await screen.findByText("Tu as le dernier pack publié.")).toBeInTheDocument();

    vi.spyOn(backend, "invoke").mockRejectedValueOnce(new Error("GitHub est injoignable : hors ligne"));
    await user.click(screen.getByRole("button", { name: "Rechercher une mise à jour du pack" }));
    expect(await screen.findByText("Recherche impossible : GitHub est injoignable : hors ligne")).toBeInTheDocument();
  });

  it("offers to install the pack from Réglages when none is installed", async () => {
    const user = userEvent.setup();
    renderApp("settings", { aiPack: NO_PACK, aiPackUpdate: UPDATE });
    expect(await screen.findByText("non installé")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Installer le pack" }));
    const pop = await screen.findByRole("dialog", { name: "Installer le pack Voix IA" });
    expect(within(pop).getByText(/Le pack ajoute les voix IA/)).toBeInTheDocument();
  });
});

describe("voice-models.com with a pack too old for online imports", () => {
  async function openExplorer(options: Parameters<typeof renderApp>[1]) {
    const user = userEvent.setup();
    const app = renderApp("voices", options);
    await user.click(await screen.findByRole("radio", { name: "IA" }));
    await user.click(screen.getByRole("button", { name: "Importer une voix IA" }));
    const panel = screen.getByRole("complementary", { name: "Importer une voix IA" });
    return { ...app, user, panel };
  }

  it("says so above the models, disables « Ajouter » and opens the pack update", async () => {
    // « Plus tard » answered earlier: no pop-up at launch, the explorer's button opens it.
    window.localStorage.setItem(AI_PACK_DISMISSED_KEY, "15");
    const { user, panel } = await openExplorer({ aiPack: OLD_PACK, aiPackUpdate: UPDATE });
    expect(within(panel).getByText(/installé est trop ancien pour ajouter des modèles en ligne/)).toBeInTheDocument();
    const add = await within(panel).findAllByRole("button", { name: /^Ajouter / });
    expect(add[0]).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: "Mettre à jour le pack" }));
    expect(await packDialog()).toBeInTheDocument();
  });

  it("says when no newer pack is published yet", async () => {
    const { user, panel } = await openExplorer({ aiPack: OLD_PACK });
    await user.click(within(panel).getByRole("button", { name: "Mettre à jour le pack" }));
    expect(await within(panel).findByText(/Aucun pack plus récent n’est encore publié/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
