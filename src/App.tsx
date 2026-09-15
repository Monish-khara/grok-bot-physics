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
        <h1>Grok Bots · Cloud Racetrack</h1>
        <p>Tap a racer to boost it. Tap the cloud to wobble it, drag it to turn it.</p>
      </header>
      <Leva collapsed={window.innerWidth < 720} titleBar={{ title: "Physics" }} />
    </div>
  );
}
