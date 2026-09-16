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
        <h1>Grok Bots · Exploded View</h1>
        <p>Four bots nested inside one another, each outer one a hollow shell split in two. Slide explode to take them apart.</p>
      </header>
      <Leva collapsed={window.innerWidth < 720} titleBar={{ title: "Exploded" }} />
    </div>
  );
}
