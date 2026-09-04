# Porting the Grok Bots physics scene

How to run this project standalone and how to lift the scene into another
React app.

## Prerequisites

- Node.js 20 (developed and verified on **v20.19.4**); npm 10.
- A browser with WebGL and WebAssembly (any current Chrome, Safari, Firefox).

## Run standalone

```bash
npm install
npm run dev      # http://127.0.0.1:4731/ (fixed port, see vite.config.ts)
npm run build    # tsc -b && vite build → dist/
npm run lint     # oxlint
```

## Dependencies (from `package.json`)

Runtime:

| Package | Version |
|---|---|
| `three` | ^0.185.1 |
| `@react-three/fiber` | ^9.7.0 |
| `@react-three/drei` | ^10.7.8 |
| `@react-three/rapier` | ^2.2.0 |
| `leva` | ^0.10.1 |
| `react` / `react-dom` | ^19.2.8 |

Dev: `vite` ^8.2.2, `@vitejs/plugin-react` ^6.1.0, `typescript` ~6.0.2,
`@types/three` ^0.185.4, `@types/react` ^19.2.18, `@types/react-dom` ^19.2.4,
`@types/node` ^24.13.3, `oxlint` ^1.79.0.

`@react-three/rapier` pulls in `@dimforge/rapier3d-compat` transitively; it is
imported directly in `src/Status.tsx`, so no extra install is needed.

## Dropping the scene into another React app

Copy these files, keeping the relative layout so the imports resolve:

```
src/Scene.tsx        # Canvas, camera rig, floor/walls, Leva panel, respawn, click handling
src/Bot.tsx          # RigidBody + hull collider + body/eye meshes, tap/drag/flick
src/geometry.ts      # body + eye geometry builders (analytic + marching cubes), SDFs
src/Status.tsx       # WebGL / WASM detection, loading + error overlays, error boundary
src/data/bodies.ts   # 3D body definitions and eye formations for the ten bots
src/data/shapes.ts   # roster + 2D outlines
src/data/tokens.ts   # color tokens
src/App.css          # .app / .hud / .status styles (or fold into your own CSS)
```

Then mount it. The minimal host is what `src/App.tsx` does:

```tsx
import { Leva } from "leva";
import { Scene } from "./Scene";
import { SceneErrorBoundary } from "./Status";
import "./App.css";

export function GrokBotsDrop() {
  return (
    <div className="app">          {/* position: fixed; inset: 0 — give it a sized box */}
      <SceneErrorBoundary>
        <Scene />
      </SceneErrorBoundary>
      <Leva collapsed titleBar={{ title: "Physics" }} />
    </div>
  );
}
```

Notes for the host app:

- **Container size.** `.app` is `position: fixed; inset: 0`. If you want the
  scene inside a panel instead of full-screen, give the wrapper any
  `position: relative` box with a height; the R3F `Canvas` fills its parent and
  the camera rig re-derives the walls from the canvas size.
- **WebGL fallback.** `Status.tsx` provides `detectWebGL()`, `useRapierReady()`,
  `useGlobalErrors()`, `StatusOverlay` and `SceneErrorBoundary`. `Scene.tsx`
  already uses them: if WebGL is unavailable, the Rapier WASM fails to load, or
  the scene throws, an on-screen card explains which stage failed with
  diagnostics instead of a blank canvas. Keep `Status.tsx` (or wire your own
  boundary around `<Scene />`).
- **Leva.** The `<Leva />` root can live anywhere in your tree; `Scene.tsx`
  registers its controls with `useControls`. Drop `<Leva />` if you don't want
  the panel — the defaults still apply (`hidden` prop also works).
- **TypeScript.** `tsconfig.app.json` uses `"moduleResolution": "bundler"` and
  `"jsx": "react-jsx"`; match those or the `three/examples/jsm/...` imports in
  `geometry.ts` will not resolve.
- **`?lineup` and test hooks.** `Scene.tsx` reads `location.search` for
  `?lineup` (spawns a spaced row) and sets `window.__grokBotsReady`,
  `window.__grokBotPositions`, `window.__grokBotsBuildMs` for headless checks.
  Harmless in production; delete if you prefer.

## Vite / WASM note for Rapier

This project uses the **`-compat`** build of Rapier (`@dimforge/rapier3d-compat`,
via `@react-three/rapier`). It embeds the WASM binary as base64 inside the JS
and instantiates it at runtime with `await rapier.init()`, so:

- No `vite-plugin-wasm`, `vite-plugin-top-level-await`, or `assetsInclude`
  configuration is needed; the checked-in `vite.config.ts` is just
  `plugins: [react()]`. The same applies to Next.js, CRA and plain Rollup.
- The bundle carries ~2 MB of physics WASM+glue; `Status.tsx` loads it with a
  dynamic `import()` so it splits into its own chunk.
- If your host has a CSP, WebAssembly compilation needs `'wasm-unsafe-eval'`
  in `script-src` (or `'unsafe-eval'` on older browsers). Without it the app
  shows the "Physics engine (Rapier WASM) failed to load" card.
- If you switch to the non-compat `@dimforge/rapier3d` package, you *will* need
  a WASM-aware bundler setup (`vite-plugin-wasm` + top-level await); the compat
  build is the simpler path and is what `@react-three/rapier` targets.

## Assets

`public/favicon.svg` and `public/icons.svg` are only used by `index.html`; the
scene itself loads no external assets — all geometry is generated at startup
(about 1–1.5 s for all ten bodies, cached for the session).
