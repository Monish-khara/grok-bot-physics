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
        <p>Hollow shells, one inside the next. Each turns to show its window and the shell behind it, then they close again. Tap to turn the next one now.</p>
      </header>
      <Leva collapsed={window.innerWidth < 720} titleBar={{ title: "Nesting" }} />
    </div>
  );
}
