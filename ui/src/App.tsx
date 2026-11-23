import { useEffect, useState } from "react";
import { BottomBar } from "./components/BottomBar";
import { Sidebar, type ScreenKey } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { newerStatus, useVox } from "./state/store";
import { VoicesScreen } from "./screens/VoicesScreen";
import { SoundsScreen } from "./screens/SoundsScreen";
import { EditorScreen } from "./screens/EditorScreen";
import { AiScreen } from "./screens/AiScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export function App({ initialScreen = "voices" }: { initialScreen?: ScreenKey }) {
  const [screen, setScreen] = useState<ScreenKey>(initialScreen);
  const [editVoiceId, setEditVoiceId] = useState<string | null>(null);
  const { backend, notify, setSnapshot } = useVox();

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

  const openEditor = (voiceId: string | null) => {
    setEditVoiceId(voiceId);
    setScreen("editor");
  };

  return (
    <div className="app">
      <Sidebar screen={screen} onNavigate={setScreen} />
      <main className="main" id="contenu">
        {screen === "voices" && <VoicesScreen onEdit={openEditor} />}
        {screen === "sounds" && <SoundsScreen />}
        {screen === "editor" && <EditorScreen initialVoiceId={editVoiceId} />}
        {screen === "ai" && <AiScreen />}
        {screen === "settings" && <SettingsScreen />}
      </main>
      <BottomBar />
      <Toasts />
    </div>
  );
}
