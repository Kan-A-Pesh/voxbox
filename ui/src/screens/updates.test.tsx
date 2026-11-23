import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { createMockBackend, MOCK_APP_VERSION } from "../ipc/mock";
import { CHECK_EVERY_MS, DISMISSED_KEY } from "../state/updates";
import { VoxProvider } from "../state/store";
import { App } from "../App";

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

// The first check runs once the app has booted, which is slow on a loaded test runner.
const SLOW = { timeout: 5000 };
const dialog = () => screen.findByRole("dialog", { name: /VoxBox 0\.1\.42 est disponible/ }, SLOW);

describe("in-app updates", () => {
  it("stays quiet when this version is the latest, and says so when asked", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("settings");
    await waitFor(() => expect(backend.updateChecks()).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/est disponible/)).toBeNull();
    expect(await screen.findByText(MOCK_APP_VERSION)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rechercher une mise à jour" }));
    expect(await screen.findByText("Tu as la dernière version.")).toBeInTheDocument();
    expect(backend.updateChecks()).toBe(2);
  });

  it("shows the pop-up once per version, then only the banner", async () => {
    const user = userEvent.setup();
    const first = renderApp("voices", { update: { version: "0.1.42" } });
    const pop = await dialog();
    expect(within(pop).getByText(new RegExp(`Tu as la version ${MOCK_APP_VERSION.replace(/\./g, "\\.")}`))).toBeInTheDocument();
    expect(within(pop).getByRole("button", { name: "Mettre à jour" })).toHaveFocus();

    await user.click(within(pop).getByRole("button", { name: "Plus tard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("VoxBox 0.1.42 est disponible.")).toBeInTheDocument();
    expect(window.localStorage.getItem(DISMISSED_KEY)).toBe("0.1.42");
    first.unmount();

    // Next launch: same version, no pop-up, the banner is back.
    const second = renderApp("voices", { update: { version: "0.1.42" } });
    expect(await screen.findByText("VoxBox 0.1.42 est disponible.", {}, SLOW)).toBeInTheDocument();
    await waitFor(() => expect(second.backend.updateChecks()).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 15_000); // Two app launches, each waiting up to SLOW for its first check.

  it("keeps focus inside the pop-up: background inert, backdrop clicks and Shift+Tab included", async () => {
    const user = userEvent.setup();
    const { container } = renderApp("voices", { update: { version: "0.1.42" } });
    const pop = await dialog();
    const update = within(pop).getByRole("button", { name: "Mettre à jour" });
    const later = within(pop).getByRole("button", { name: "Plus tard" });
    const app = container.querySelector(".app");
    if (!app) throw new Error("no .app");
    const background = [...app.children].filter((el) => !el.contains(pop));
    expect(background.length).toBeGreaterThan(0);
    for (const el of background) expect(el).toHaveAttribute("inert");

    // A click on the backdrop keeps focus in the dialog.
    const backdrop = pop.parentElement;
    if (!backdrop) throw new Error("no backdrop");
    await user.click(backdrop);
    expect(update).toHaveFocus();
    await user.tab({ shift: true });
    expect(later).toHaveFocus();
    await user.tab();
    expect(update).toHaveFocus();

    // Focus lost anyway (e.g. to the body): Tab brings it back, Esc still answers.
    update.blur();
    await user.tab();
    expect(update).toHaveFocus();
    update.blur();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const el of background) expect(el).not.toHaveAttribute("inert");
  });

  it("keeps text in the pop-up selectable: only the backdrop holds the mouse", async () => {
    const pop = await (renderApp("voices", { update: { version: "0.1.42" } }), dialog());
    const backdrop = pop.parentElement;
    if (!backdrop) throw new Error("no backdrop");
    // fireEvent returns false when the default action was prevented.
    expect(fireEvent.mouseDown(within(pop).getByText(/Tu as la version/))).toBe(true);
    expect(fireEvent.mouseDown(backdrop)).toBe(false);
  });

  it("ignores files dropped on the window while the pop-up is open", async () => {
    const user = userEvent.setup();
    const { backend, callsOf } = renderApp("sounds", { update: { version: "0.1.42" } });
    const pop = await dialog();
    await waitFor(() => expect(backend.hasDropListener()).toBe(true));
    act(() => backend.simulateDrop(["C:\\Sons\\Gong.ogg"]));
    await act(async () => {});
    expect(callsOf("import_sounds")).toHaveLength(0);

    await user.click(within(pop).getByRole("button", { name: "Plus tard" }));
    act(() => backend.simulateDrop(["C:\\Sons\\Gong.ogg"]));
    await waitFor(() => expect(callsOf("import_sounds")).toHaveLength(1));
  });

  it.each(["leave", "drop"] as const)("clears a drag that ends (%s) while the pop-up is open", async (end) => {
    const user = userEvent.setup();
    const backend = createMockBackend({ meters: false, update: { version: "0.1.42" } });
    const open = backend.holdUpdateChecks();
    const { container } = render(
      <VoxProvider backend={backend}>
        <App initialScreen="sounds" />
      </VoxProvider>,
    );
    await waitFor(() => expect(backend.hasDropListener()).toBe(true));
    act(() => backend.simulateDragEvent({ type: "over" }));
    expect(container.querySelector(".dropzone")).not.toBeNull();

    open();
    const pop = await dialog();
    expect(container.querySelector(".dropzone")).toBeNull();
    act(() => backend.simulateDragEvent(end === "leave" ? { type: "leave" } : { type: "drop", paths: ["C:\\Sons\\Gong.ogg"] }));
    await user.click(within(pop).getByRole("button", { name: "Plus tard" }));
    expect(container.querySelector(".dropzone")).toBeNull();
    expect(backend.calls.filter((c) => c.cmd === "import_sounds")).toHaveLength(0);
  });

  it("gives focus back to the banner when a pop-up it opened is closed", async () => {
    const user = userEvent.setup();
    renderApp("voices", { update: { version: "0.1.42", failWith: "réseau coupé" } });
    await user.click(within(await dialog()).getByRole("button", { name: "Plus tard" }));
    await user.click(screen.getByRole("button", { name: "Mettre à jour" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("réseau coupé");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Réessayer" })).toHaveFocus());
  });

  it("Échap answers « Plus tard »", async () => {
    const user = userEvent.setup();
    renderApp("voices", { update: { version: "0.1.42" } });
    await dialog();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("VoxBox 0.1.42 est disponible.")).toBeInTheDocument();
  });

  it("checks again every 6 hours and offers a newer version with a new pop-up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { backend } = renderApp("voices");
    await waitFor(() => expect(backend.updateChecks()).toBe(1));

    backend.setUpdate({ version: "0.1.42" });
    await act(async () => {
      vi.advanceTimersByTime(CHECK_EVERY_MS - 1000);
    });
    expect(backend.updateChecks()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await user.click(within(await dialog()).getByRole("button", { name: "Plus tard" }));

    // Six hours later the same version is still out: banner only.
    await act(async () => {
      vi.advanceTimersByTime(CHECK_EVERY_MS);
    });
    await waitFor(() => expect(backend.updateChecks()).toBe(3));
    expect(screen.queryByRole("dialog")).toBeNull();

    backend.setUpdate({ version: "0.1.43" });
    await act(async () => {
      vi.advanceTimersByTime(CHECK_EVERY_MS);
    });
    expect(await screen.findByRole("dialog", { name: /VoxBox 0\.1\.43 est disponible/ })).toBeInTheDocument();
  });

  it("downloads with progress, installs and restarts on one confirmation", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices", { update: { version: "0.1.42", stepMs: 20 } });
    await user.click(within(await dialog()).getByRole("button", { name: "Mettre à jour" }));

    const progress = await screen.findByRole("progressbar", { name: "Téléchargement de la mise à jour" });
    expect(screen.getByRole("dialog", { name: "Mise à jour vers 0.1.42" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plus tard" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await waitFor(() => expect(progress).toHaveAttribute("aria-valuenow", "100"));
    await waitFor(() => expect(backend.restarted()).toBe(true));
    expect(screen.getByText(/VoxBox redémarre tout seul/)).toBeInTheDocument();
  });

  it("explains a failed install and retries it", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices", { update: { version: "0.1.42", failWith: "réseau coupé" } });
    await user.click(within(await dialog()).getByRole("button", { name: "Mettre à jour" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("La mise à jour n’a pas pu se faire");
    expect(alert).toHaveTextContent("réseau coupé");

    await user.click(screen.getByRole("button", { name: "Plus tard" }));
    expect(screen.getByText("La mise à jour vers VoxBox 0.1.42 a échoué.")).toBeInTheDocument();

    // « Réessayer » runs the install again (here it fails again, and says so).
    const finish = backend.holdInstalls();
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    finish();
    expect(await screen.findByRole("alert")).toHaveTextContent("réseau coupé");
    expect(backend.restarted()).toBe(false);
  });

  it("retries with the release of the latest check once the network is back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { backend } = renderApp("voices", { update: { version: "0.1.42", failWith: "réseau coupé" } });
    await user.click(within(await dialog()).getByRole("button", { name: "Mettre à jour" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("réseau coupé");
    await user.click(screen.getByRole("button", { name: "Plus tard" }));

    // Network back; the 6-hour check finds the same version (and releases the old object).
    backend.setUpdate({ version: "0.1.42" });
    await act(async () => {
      vi.advanceTimersByTime(CHECK_EVERY_MS);
    });
    await waitFor(() => expect(backend.updateChecks()).toBe(2));
    expect(screen.getByText("La mise à jour vers VoxBox 0.1.42 a échoué.")).toBeInTheDocument();
    // The object of the first check was replaced, hence released.
    expect(backend.releasedUpdates()).toBe(1);

    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(backend.restarted()).toBe(true));
  });

  it("a manual check shows the pop-up again for a dismissed version", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(DISMISSED_KEY, "0.1.42");
    const { backend } = renderApp("settings", { update: { version: "0.1.42" } });
    await waitFor(() => expect(backend.updateChecks()).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Installer la version 0.1.42" }));
    expect(await dialog()).toBeInTheDocument();
  });

  it("a manual check still runs with an update pending, and clears a withdrawn release", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("settings", { update: { version: "0.1.42" } });
    await user.click(within(await dialog()).getByRole("button", { name: "Plus tard" }));
    expect(screen.getByRole("button", { name: "Installer la version 0.1.42" })).toBeInTheDocument();

    backend.setUpdate(null);
    await user.click(screen.getByRole("button", { name: "Rechercher une mise à jour" }));
    expect(await screen.findByText("Tu as la dernière version.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Installer la version 0.1.42" })).toBeNull();
    expect(screen.queryByText(/est disponible/)).toBeNull();
    expect(backend.releasedUpdates()).toBe(1);
  });

  it("a failed manual check keeps the pending offer and says the check failed", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("settings", { update: { version: "0.1.42" } });
    await user.click(within(await dialog()).getByRole("button", { name: "Plus tard" }));

    // What the Tauri updater answers for a missing latest.json and for any HTTP error alike.
    backend.updates.check = () => Promise.reject("Could not fetch a valid release JSON from the remote");
    await user.click(screen.getByRole("button", { name: "Rechercher une mise à jour" }));
    expect(await screen.findByText(/Recherche impossible : Could not fetch a valid release JSON/)).toBeInTheDocument();
    expect(screen.queryByText("Tu as la dernière version.")).toBeNull();
    expect(screen.getByRole("button", { name: "Installer la version 0.1.42" })).toBeInTheDocument();
    expect(screen.getByText("VoxBox 0.1.42 est disponible.")).toBeInTheDocument();
    expect(backend.releasedUpdates()).toBe(0);
  });

  it("a manual check during the launch check shares it instead of racing it", async () => {
    const user = userEvent.setup();
    const backend = createMockBackend({ meters: false, update: { version: "0.1.42" } });
    const open = backend.holdUpdateChecks();
    render(
      <VoxProvider backend={backend}>
        <App initialScreen="settings" />
      </VoxProvider>,
    );
    await waitFor(() => expect(backend.updateChecks()).toBe(1));
    await user.click(await screen.findByRole("button", { name: "Rechercher une mise à jour" }));
    expect(screen.getByRole("button", { name: "Recherche…" })).toBeDisabled();
    open();

    const pop = await dialog();
    expect(backend.updateChecks()).toBe(1);
    expect(backend.maxConcurrentChecks()).toBe(1);
    expect(backend.releasedUpdates()).toBe(0);
    await user.click(within(pop).getByRole("button", { name: "Mettre à jour" }));
    await waitFor(() => expect(backend.restarted()).toBe(true));
  });

  it("asks before restarting over an unsaved voice, and does nothing if refused", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { backend } = renderApp("voices", { update: { version: "0.1.42" } });
    await user.click(within(await dialog()).getByRole("button", { name: "Plus tard" }));
    await user.click(screen.getByRole("button", { name: "Créer une voix" }));
    const panel = screen.getByRole("complementary", { name: "Nouvelle voix" });
    await user.type(within(panel).getByLabelText("Nom"), " grave");

    await user.click(screen.getByRole("button", { name: "Mettre à jour" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(panel).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Mettre à jour" }));
    await waitFor(() => expect(backend.restarted()).toBe(true));
    confirm.mockRestore();
  });

  it("frees the held update when the app goes away", async () => {
    const { backend, unmount } = renderApp("voices", { update: { version: "0.1.42" } });
    await dialog();
    unmount();
    expect(backend.releasedUpdates()).toBe(1);
  });

  it("says « Installation » once the download is complete, even without a known size", async () => {
    const user = userEvent.setup();
    const backend = createMockBackend({ meters: false, update: { version: "0.1.42" } });
    const original = backend.updates.check.bind(backend.updates);
    let finish: () => void = () => {};
    backend.updates.check = async () => {
      const update = await original();
      if (!update) return null;
      return {
        ...update,
        install: (onProgress) =>
          new Promise<void>((resolve) => {
            onProgress({ downloaded: 1000, total: null, finished: false });
            onProgress({ downloaded: 2000, total: null, finished: true });
            finish = resolve;
          }),
      };
    };
    render(
      <VoxProvider backend={backend}>
        <App initialScreen="voices" />
      </VoxProvider>,
    );
    await user.click(within(await dialog()).getByRole("button", { name: "Mettre à jour" }));
    expect(await screen.findByText(/Installation… VoxBox redémarre tout seul/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    finish();
  });

  it("frees the update when the app goes away during a failing install", async () => {
    const user = userEvent.setup();
    const { backend, unmount } = renderApp("voices", { update: { version: "0.1.42", failWith: "coupure" } });
    const fail = backend.holdInstalls();
    await user.click(within(await dialog()).getByRole("button", { name: "Mettre à jour" }));
    await screen.findByRole("progressbar");
    unmount();
    expect(backend.releasedUpdates()).toBe(0);
    fail();
    await waitFor(() => expect(backend.releasedUpdates()).toBe(1));
  });

  it("an offline check stays silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const backend = createMockBackend({ meters: false });
    backend.updates.check = () => Promise.reject(new Error("hors ligne"));
    render(
      <VoxProvider backend={backend}>
        <App initialScreen="voices" />
      </VoxProvider>,
    );
    await waitFor(() => expect(warn).toHaveBeenCalledWith("recherche de mise à jour impossible", expect.any(Error)));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/est disponible/)).toBeNull();
    warn.mockRestore();
  });
});
