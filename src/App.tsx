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
        <h1>Grok Bots · Sphere</h1>
        <p>Drop or Fly (panel). Tap a bot to kick it, tap empty space to scatter, drag to turn.</p>
      </header>
      <Leva collapsed={window.innerWidth < 720} titleBar={{ title: "Physics" }} />
    </div>
  );
}
