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
        <h1>Grok Bots · Russian Doll</h1>
        <p>The dome peels off layer by layer, then stacks back up. Tap it to peel the next layer now.</p>
      </header>
      <Leva collapsed={window.innerWidth < 720} titleBar={{ title: "Nesting" }} />
    </div>
  );
}
