import { Leva } from "leva";
import { Scene } from "./Scene";
import { SceneErrorBoundary } from "./Status";
import "./App.css";

export default function App() {
  return (
    <div className="app">
      <SceneErrorBoundary>
        <Scene />
      </SceneErrorBoundary>
      <header className="hud">
        <h1>Grok Bots · Zero-G Bounce</h1>
        <p>Tap a bot to nudge it. Tap empty space to send everyone a new way.</p>
      </header>
      <Leva collapsed={window.innerWidth < 720} titleBar={{ title: "Physics" }} />
    </div>
  );
}
