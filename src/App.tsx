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
        <h1>Grok Bots · Bowl of Bots</h1>
        <p>The round bot hollowed out and cut open like a bowl, with four smaller bots sitting in it. Respawn for a new cast.</p>
      </header>
      <Leva collapsed={window.innerWidth < 720} titleBar={{ title: "Bowl" }} />
    </div>
  );
}
