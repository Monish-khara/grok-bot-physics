# Grok Bots · Physics Drop

A standalone web prototype: the ten Grok Bot "Base shapes v2" bodies as true 3D
volumes rendered the way the Sand-Toolkit tool renders them (flat solid token
color, white pill eyes charted on the body surface, no lighting or shadows),
dropped into a physics box where they tumble, stack, settle, and can be poked
and spun.

![Bots mid-fall, tumbling in 3D with eyes](docs/screenshot.png)

![Bots settled, facing the camera](docs/screenshot-settled.png)

Built with Vite, React, TypeScript, three.js, React Three Fiber, drei, Rapier
(`@react-three/rapier`) and Leva.

## This branch: `canvas2d` — runs without WebGL

Cursor's built-in browser tab blocks WebGL (`getContext("webgl")` returns
null) but runs WebAssembly. This branch adds a **Canvas 2D renderer** that
kicks in automatically when WebGL is unavailable, so the same demo — Rapier
physics, all Leva controls, taps, drags, flicks — renders there too. A small
label in the bottom-left corner says which renderer is active.

![The Canvas 2D fallback, captured with WebGL disabled](docs/screenshot-canvas2d.png)

- **How:** `src/canvas2d.ts` is a drop-in for three's `WebGLRenderer` that
  React Three Fiber accepts through the `gl` prop, so the scene graph,
  physics and pointer raycasting are untouched. Each frame it projects every
  mesh through the camera, painter-sorts the bodies by view depth, and fills
  each body's **silhouette** — the loop of edges where front-facing triangles
  meet back-facing ones, oriented so the nonzero winding rule yields exactly
  the union of the front faces. Only a few hundred path segments per body are
  emitted, so a frame costs ~4 ms of JS for ten bots. Eyes are drawn after
  their body while their surface normal faces the camera, clipped to the body
  silhouette.
- **Mesh set:** the fallback uses a slightly lighter geometry set (`"low"`
  quality in `src/geometry.ts`: 96 radial segments, 96³ marching cubes) since
  every vertex is projected on the CPU; the WebGL path keeps the full set.
- **Force a renderer:** `?renderer=canvas2d` or `?renderer=webgl`.
- **Run alongside `master`:** `npx vite --port 4732 --strictPort --host 127.0.0.1`
  (this branch was served at <http://127.0.0.1:4732/> while `master` stayed on
  4731).
- **Known differences from WebGL:** depth is resolved per body, not per pixel,
  so two bots that interpenetrate (rare — colliders keep them apart) overlap
  in centre-depth order; an eye at a grazing angle shows its full pill
  footprint clipped to the body rather than the depth-tested sliver; no
  antialiasing differences worth noting.

## Run

```bash
npm install
npm run dev
```

Opens on <http://127.0.0.1:4731/> (fixed port, see `vite.config.ts`).

## Controls

- **Tap / click a bot** — kicks it upward with a little spin.
- **Drag a bot** — turns it in place like a tile in the tool (yaw with
  horizontal drag, pitch with vertical, 0.35°/px by default); release with a
  flick to spin it. It is held in the air while dragged.
- **Tap / click empty space** — radial scatter burst from that point.
- **Leva panel (top right)**
  - `background` — first row: RGB colour picker for the stage (click the
    swatch for the picker, or type a hex). Default white, like the tool.
    Applies live to both the canvas clear colour and the page behind it; the
    HUD text flips light on dark backgrounds.
  - `gravity` — downward acceleration.
  - `bounce` — collider restitution.
  - `friction` — collider friction.
  - `impulse strength` — size of the tap kick and scatter burst.
  - `drag spin` — degrees of rotation per pixel of drag.
  - `face seeking` — a soft weeble torque that swings tumbling bots back to face
    the camera upright, so eyes stay readable once they settle. 0 disables it.
  - `bot scale` — 0.5×–2× size multiplier for every bot, applied live to the
    meshes and their colliders (the play space deepens to fit, and tap
    impulses scale with mass so kicks feel the same). Respawn re-drops at the
    current scale with spacing adjusted so big bots land inside the walls.
  - `face camera` — off by default (full 3D tumbling). On: bots keep their
    face toward the viewer (no depth travel, spin only about the view axis).
  - `Respawn` — re-drops all ten bots with reshuffled colors.

Works with touch on mobile; the panel starts collapsed on narrow screens.
Add `?lineup` to the URL to drop the bots in one evenly spaced, upright row
(handy for screenshots).

## Troubleshooting

If the title and panel render but the scene is blank, an on-screen card says
which stage failed and prints diagnostics (WebGL renderer string, WebAssembly
availability, viewport, user agent):

- **WebGL is not available** — on this branch the demo falls back to the
  Canvas 2D renderer automatically (see above), so Cursor's built-in browser
  tab works. `master` shows an error card instead.
- **Physics engine (Rapier WASM) failed to load** — WebAssembly compilation is
  blocked (CSP or policy).
- **Runtime error / The scene crashed** — a JavaScript error; the message is shown.

## Data sources

Copied read-only from the Sand-Toolkit repo:

- `src/data/shapes.ts` — the ten SVG outlines (229-unit box) from
  `figma-plugins/baby-grok-expressions/src/grok-bot/shapes.ts`, roster order from
  `web/src/baby-grok/BabyGrokBaseShapesV2App.tsx` (`BASE_SHAPES_V2`).
- `src/data/bodies.ts` — the 3D body definitions and eye formations, dumped by
  running the tool's own code: `playgroundSpec(form, true)` from
  `web/src/star/playgroundBodies.ts` (rounded-slab extrusions for sparkle,
  clover, flower; rounded lofts for cloud and chubby heart; surfaces of
  revolution for teardrop and wedge; a ball-chain capsule for tablet; a rounded
  cube for square; the blob is the unit sphere) and `buildParams(form,
  "neutral", "front")` from `web/src/baby-grok/BabyGrokShapeCollectionApp.tsx`
  plus the per-tile tuning in `BabyGrokBaseShapesV2App.tsx`.
- `src/data/tokens.ts` — the 12 core color tokens from
  `web/src/baby-grok/alphaLadder.ts` (`ALPHA_CORE_RGB`). Bots use the nine hues
  (black, white and gray are skipped), so one hue repeats across ten bots.

## How it works

- `src/geometry.ts` builds each body as smooth analytic geometry wherever the
  definition allows it, so silhouettes stay clean at any zoom: the teardrop and
  wedge are `LatheGeometry` surfaces of revolution (192 segments) from their
  profile curves, refitted with a local quadratic smoother, made monotone
  toward the tips and closed with a tangent spherical fillet at each pointed
  end (the tool's own revolve closes those to a rounded axis point); the blob,
  square and tablet are a
  sphere, a `RoundedBoxGeometry` and a capsule; the cloud and heart are the
  tool's rounded loft stitched directly from scaled cross-sections. Only the
  three bevelled slabs (sparkle, clover, star) still go through three's
  `MarchingCubes`, at 128³ with every vertex then snapped onto the exact SDF
  surface. Each body also has a signed distance field, used to place the two
  eyes: each is a solid white pill (an extruded stadium) set into the body
  along the surface normal at its centre, sunk 0.04 body units below the
  surface with a 0.025 lip standing proud, so the ordinary depth test hides
  the buried part and the whole eye once the face turns away — no lift or
  polygon offset. All ten build once in about a second and are reused across
  respawns and rescales. Bodies use an unlit `MeshBasicMaterial` with the
  exact token hex; eyes are paper-white, like the tool's carved eyes.
- `src/Bot.tsx` wraps each body in a Rapier `RigidBody` with a convex-hull
  collider built from a thinned copy of the mesh vertices, scaled with the
  `bot scale` setting (ball/box fallback if the hull fails), and handles tap,
  drag-to-rotate and flick.
- `src/canvas2d.ts` (this branch) is the Canvas 2D fallback renderer described
  above; `Scene.tsx` picks it when `detectWebGL()` fails or `?renderer=canvas2d`
  is set, and hands the bots the lighter geometry set.
- `src/Scene.tsx` sets up an orthographic camera looking down -Z, an invisible
  floor and walls at the viewport edges, a shallow front/back slab, the
  face-seeking torque, click handling and the Leva panel.
