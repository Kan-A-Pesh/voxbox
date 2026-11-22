import { useEffect, useState } from "react";
import { BottomBar } from "./components/BottomBar";
import { Sidebar, type ScreenKey } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { useVox } from "./state/store";
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
    backend
      .listen("engine", (e) => {
        if (e.type !== "deviceError") return;
        notify(e.message, "error");
        // The engine may have stopped or switched devices: show its real status.
        backend
          .invoke("get_snapshot", {})
          .then((fresh) => setSnapshot((s) => ({ ...s, status: fresh.status, settings: fresh.settings })))
          .catch((err) => console.warn("état du moteur non rafraîchi", err));
      })
      .then((u) => (alive ? (unlisten = u) : u()));
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
