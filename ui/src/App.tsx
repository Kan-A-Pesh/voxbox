import { useEffect, useRef, useState } from "react";
import { BottomBar } from "./components/BottomBar";
import { Sidebar, type ScreenKey } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { newerStatus, useVox } from "./state/store";
import { VoicesScreen } from "./screens/VoicesScreen";
import { SoundsScreen } from "./screens/SoundsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export function App({ initialScreen = "voices" }: { initialScreen?: ScreenKey }) {
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
  const { backend, notify, setSnapshot } = useVox();
  // A screen holding unsaved work registers a guard; leaving it asks first.
  const leaveGuard = useRef<(() => boolean) | null>(null);
  const navigate = (next: ScreenKey) => {
    if (next === screen || (leaveGuard.current && !leaveGuard.current())) return;
    leaveGuard.current = null;
    setScreen(next);
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    // Engine status reads can resolve out of order: keep the newest revision.
    const refreshStatus = () => {
      backend
        .invoke("get_snapshot", {})
        .then((fresh) => {
          if (alive) setSnapshot((s) => ({ ...s, status: newerStatus(s.status, fresh.status) }));
        })
        .catch((err) => console.warn("état du moteur non rafraîchi", err));
    };
    backend
      .listen("engine", (e) => {
        if (e.type === "deviceError") notify(e.message, "error");
        else if (e.type === "recovered") notify(e.message, "info");
        else if (e.type !== "statusChanged") return;
        refreshStatus();
      })
      .then((u) => {
        if (!alive) return u();
        unlisten = u;
        // Events sent before this listener existed (e.g. a restart during
        // startup) are missed: read the status once now that we listen.
        refreshStatus();
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [backend, notify, setSnapshot]);

  return (
    <div className="app">
      <Sidebar screen={screen} onNavigate={navigate} />
      <main className="main" id="contenu">
        {screen === "voices" && <VoicesScreen leaveGuardRef={leaveGuard} />}
        {screen === "sounds" && <SoundsScreen />}
        {screen === "settings" && <SettingsScreen />}
      </main>
      <BottomBar onOpenSettings={() => navigate("settings")} />
      <Toasts />
    </div>
  );
}
