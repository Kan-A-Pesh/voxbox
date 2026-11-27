import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../test/render";
import { createMockBackend } from "../ipc/mock";
import { ErrorPanel } from "../components/Controls";
import { VoxProvider } from "../state/store";
import { App } from "../App";
import { logClientError, resetClientLog, setLogBackend } from "../lib/clientLog";

afterEach(() => {
  resetClientLog();
  vi.useRealTimers();
});

const logged = (calls: { cmd: string; args: unknown }[]) =>
  calls.filter((c) => c.cmd === "log_client_error").map((c) => c.args);

describe("errors shown by the app land in voxbox.log", () => {
  it("writes errors raised before the backend is ready, once, and skips quick repeats", () => {
    const backend = createMockBackend({ meters: false });
    logClientError("démarrage", "pas de moteur");
    expect(logged(backend.calls)).toEqual([]);
    setLogBackend(backend);
    expect(logged(backend.calls)).toEqual([{ context: "démarrage", message: "pas de moteur" }]);
    logClientError("démarrage", "pas de moteur");
    expect(logged(backend.calls)).toHaveLength(1);
    logClientError("ailleurs", "pas de moteur");
    expect(logged(backend.calls)).toHaveLength(2);
  });

  it("never throws when writing fails", async () => {
    const backend = createMockBackend({ meters: false });
    vi.spyOn(backend, "invoke").mockRejectedValue(new Error("hors service"));
    setLogBackend(backend);
    expect(() => logClientError("x", "y")).not.toThrow();
    await Promise.resolve();
  });

  it("an error panel writes its message, unless it already comes from the log", () => {
    const backend = createMockBackend({ meters: false });
    setLogBackend(backend);
    render(
      <>
        <ErrorPanel title="Import impossible" message="OMP: Error #15" />
        <ErrorPanel title="Le son est coupé" message="déjà journalisé" logged />
      </>,
    );
    expect(logged(backend.calls)).toEqual([{ context: "Import impossible", message: "OMP: Error #15" }]);
  });

  it("a failing startup is written as soon as the bridge exists", async () => {
    const backend = createMockBackend({ meters: false });
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) =>
      cmd === "get_snapshot" ? Promise.reject(new Error("store illisible")) : invoke(cmd as never, args as never)) as typeof backend.invoke);
    render(
      <VoxProvider backend={backend}>
        <App initialScreen="voices" />
      </VoxProvider>,
    );
    await waitFor(() =>
      expect(logged(backend.calls)).toEqual([{ context: "démarrage de l'interface", message: "store illisible" }]),
    );
  });

  it("an error toast is written, an engine message is not written twice", async () => {
    const user = userEvent.setup();
    const { backend } = renderApp("voices");
    await screen.findByRole("heading", { name: "Voix" });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    act(() => backend.simulateDeviceLoss("Casque débranché"));
    expect(await screen.findAllByText(/Casque débranché/)).not.toHaveLength(0);
    expect(logged(backend.calls)).toEqual([]);

    // A command that fails shows a toast, which is written.
    const invoke = backend.invoke.bind(backend);
    vi.spyOn(backend, "invoke").mockImplementation(((cmd: string, args: unknown) =>
      cmd === "open_logs_folder"
        ? Promise.reject(new Error("Explorateur introuvable"))
        : invoke(cmd as never, args as never)) as typeof backend.invoke);
    await user.click(screen.getByRole("button", { name: /^Réglages/ }));
    await user.click((await screen.findAllByRole("button", { name: "Ouvrir le dossier des journaux" }))[0]!);
    expect(await screen.findByText("Explorateur introuvable")).toBeInTheDocument();
    await waitFor(() =>
      expect(logged(backend.calls)).toEqual([{ context: "message d'erreur", message: "Explorateur introuvable" }]),
    );
  });
});
