# Grok Bots · Physics Drop

A standalone web prototype: the ten Grok Bot "Base shapes v2" bodies, extruded
into soft 3D pillows in their brand colors, dropped into a physics box where they
stack, settle, and can be poked around.

![Ten puffy bots settled on the floor](docs/screenshot.png)

Built with Vite, React, TypeScript, three.js, React Three Fiber, drei, Rapier
(`@react-three/rapier`) and Leva.

## Run

```bash
npm install
npm run dev
```

Opens on <http://127.0.0.1:4731/> (fixed port, see `vite.config.ts`).

## Controls

- **Tap / click a bot** — kicks it upward with a little spin.
- **Tap / click empty space** — radial scatter burst from that point.
- **Leva panel (top right)**
  - `gravity` — downward acceleration.
  - `bounce` — collider restitution.
  - `friction` — collider friction.
  - `impulse strength` — size of the tap kick and scatter burst.
  - `face camera` — on by default: bots keep their silhouette toward the viewer
    (no depth travel, spin only about the view axis). Turn off for full 3D tumbling.
  - `Respawn` — re-drops all ten bots with reshuffled colors.

Works with touch on mobile; the panel starts collapsed on narrow screens.

## Data sources

Copied read-only from the Sand-Toolkit repo:

- `src/data/shapes.ts` — the ten SVG outlines (229-unit box) from
  `figma-plugins/baby-grok-expressions/src/grok-bot/shapes.ts`, roster order from
  `web/src/baby-grok/BabyGrokBaseShapesV2App.tsx` (`BASE_SHAPES_V2`). "flower"
  is the `star6` body; "blob" is `HEAD` from `grok-bot/geometry.ts`.
- `src/data/tokens.ts` — the 12 core color tokens from
  `web/src/baby-grok/alphaLadder.ts` (`ALPHA_CORE_RGB`). Bots use the nine hues
  (black, white and gray are skipped), so one hue repeats across ten bots.

## How it works

- `src/geometry.ts` parses each path with three's `SVGLoader`, extrudes it with a
  rounded bevel, welds vertices for smooth shading, flips SVG's y-down to y-up,
  normalizes every body to the same footprint, and centres it.
- `src/Bot.tsx` wraps each mesh in a Rapier `RigidBody` with a convex-hull
  collider built from a thinned copy of the mesh vertices. If Rapier cannot build
  a hull it falls back to a ball or box collider.
- `src/Scene.tsx` sets up the floor, invisible walls at the viewport edges, a
  shallow front/back slab, lighting, contact shadows, click handling and the Leva
  panel.
