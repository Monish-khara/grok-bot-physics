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

## This branch: `fly` — zero-gravity bounce

Branched from `canvas2d` (so it keeps the WebGL / Canvas 2D auto-detect and
runs in Cursor's built-in browser). Instead of dropping into a pile, the ten
bots drift through the viewport at one constant speed, spinning gently, and
bounce off the frame edges like a screensaver.

![Bots flying in zero gravity, WebGL renderer](docs/screenshot-fly.png)

- **Physics:** gravity defaults to `0`; every bot spawns spread over the
  visible area (jittered grid, so none start overlapping) with a random
  heading at the shared `speed` and a small random spin. Rigid bodies use
  restitution `1`, friction `0`, no linear or angular damping, never sleep,
  and have CCD on so a fast bot cannot tunnel through a wall.
- **Walls:** six invisible colliders sized from the camera frustum — left,
  right, top, bottom, plus a shallow front/back pair — so the troop stays in
  one depth band and always in frame. They resize with the window.
- **Speed normaliser:** after every physics step each free-flying bot's
  velocity is rescaled to exactly `speed` (the solver's elastic bounces and
  bot-bot collisions are never quite lossless), and its spin is capped at
  `spin`. A bot that has stopped (released from a drag without a flick) is
  sent off in a fresh random direction. The normaliser only runs while
  `gravity` is `0`; raise gravity and the bots fall and bounce elastically.
- **Interaction:** tapping a bot shoves it in a random direction (the
  normaliser turns that into a change of heading) with some spin; tapping
  empty space gives every bot a new random heading and spin; drag-to-rotate
  and flick work as before, and a flick also sets the release heading.
- **Leva panel:** `speed` (default 6 units/s), `spin` (default 1.5 rad/s,
  also the cap), `gravity` (default 0), `bounce` (default 1), `trail`,
  `blur`, `impulse strength`, `drag spin`, `bot scale`, `face camera`,
  `Respawn`. `friction` and `face seeking` are gone: friction no longer
  matters, and the face-seeking torque would oscillate forever with no damping.

### Trails and speed blur

![Trail 0.6 and blur 1 in the Canvas 2D renderer](docs/screenshot-fly-trails.png)

Two effect sliders, both `0` (off) by default so the plain look is unchanged.
`?trail=0.6&blur=1` in the URL presets them.

- **`trail`** (0–1) — each bot leaves fading copies of itself in its own
  colour along its path; the slider is persistence (up to 2 s at `1`).
  - *Canvas 2D* (`src/canvas2d.ts`): the renderer snapshots each body's
    silhouette `Path2D` as it moves (at most 24 alive per body, spaced in
    time, skipped while a bot is parked) and refills them under the live
    bodies, oldest and faintest first. The frame is still fully cleared to
    the background every time, so there is none of the residue an alpha
    fade-clear leaves (8-bit blending stalls a few levels short of the
    background and never finishes), and a new background colour is exact
    immediately. Ghosts are body-only (no eyes), which reads as a colour trail.
  - *WebGL* (`WebGLTrail` in `src/Scene.tsx`): a real fade-clear. The scene
    accumulates in a 32-bit float render target that is washed toward the
    background with a translucent full-screen quad each frame (time-based, so
    the fade rate is frame-rate independent), the bots are drawn on top, and
    the target is blitted to the screen. Float accumulation converges all the
    way to the background; a background change just fades in. Falls back to
    an 8-bit target (with the usual faint residue) if `EXT_color_buffer_float`
    is missing. Because it fades the whole frame, WebGL ghosts include the
    eyes and look like a continuous smear rather than stamped copies.
- **`blur`** (0–1) — speed blur: the body *and its eyes* are redrawn stepped
  backwards along the velocity with decreasing alpha, then drawn solid on
  top. Smear length is `speed × blur × 0.16 s` of travel, so faster bots
  smear more and a held bot does not smear at all.
  - *Canvas 2D*: up to 8 translated refills of the already-built body and eye
    paths (one every ~8 px), using the world velocity the scene writes to
    `mesh.userData.velocity`, projected to screen space.
  - *WebGL*: six translucent ghost meshes per bot (`Bot.tsx`), posed each
    frame behind the body along its velocity and nudged slightly farther from
    the camera so the solid body wins the depth test. Many extra draws of the
    full-resolution meshes; fine on a GPU, slow under software GL.
- **Cost** (headless Chromium, software Canvas 2D, 1280×800, ten bots): the
  renderer's own JS time stays at ~2.1–2.4 ms/frame with everything on; what
  grows is rasterisation of the extra fills (≈360 per frame at `trail 1`,
  `blur 1`): the frame rate held 120 → 72 fps at DPR 1 and 120 → 46 fps at
  DPR 2 in that fully software setup. With GPU-accelerated canvas the fills
  are much cheaper.
- **Run alongside the other branches:** the worktree lives at
  `~/repos/grok-bot-physics-fly` and is served on port `4733`
  (`master` on 4731, `canvas2d` on 4732):

  ```bash
  cd ~/repos/grok-bot-physics-fly
  npm install
  npm run dev -- --port 4733 --strictPort
  # → http://127.0.0.1:4733/
  ```

  Or detached: `screen -dmS grok-bot-physics-fly bash -lc 'cd ~/repos/grok-bot-physics-fly && npm run dev -- --port 4733 --strictPort 2>&1 | tee /tmp/grok-bot-physics-fly.log'`.
- **Test hooks** (for headless checks): `window.__grokBotPositions()`,
  `window.__grokBotVelocities()` (with `speed`), `window.__grokBotBounds()`.
  Verified headless with WebGL disabled (`--disable-gpu --disable-webgl
  --disable-3d-apis`, Canvas 2D renderer) and with SwiftShader WebGL: all ten
  bots stayed inside the walls for 60 s, speeds held within 0.01% of the
  target, no console errors.

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

- **Tap / click a bot** — shoves it in a random direction with a little spin
  (on this branch the speed normaliser keeps it at `speed`, so the tap
  changes its heading).
- **Drag a bot** — turns it in place like a tile in the tool (yaw with
  horizontal drag, pitch with vertical, 0.35°/px by default); release with a
  flick to spin it and send it off that way. It is held still while dragged.
- **Tap / click empty space** — every bot picks a new random heading and spin.
- **Leva panel (top right)**
  - `background` — first row: RGB colour picker for the stage (click the
    swatch for the picker, or type a hex). Default white, like the tool.
    Applies live to both the canvas clear colour and the page behind it; the
    HUD text flips light on dark backgrounds.
  - `speed` — flight speed every bot is held at, world units per second.
  - `spin` — angular speed at spawn and the cap collisions may not exceed.
  - `gravity` — downward acceleration, default 0. Above 0 the normaliser
    switches off and the bots fall and bounce.
  - `bounce` — collider restitution (1 = fully elastic).
  - `trail` — persistence of the colour trail each bot leaves (0 = off).
  - `blur` — speed blur along each bot's velocity (0 = off).
  - `impulse strength` — size of the tap shove.
  - `drag spin` — degrees of rotation per pixel of drag.
  - `bot scale` — 0.5×–2× size multiplier for every bot, applied live to the
    meshes and their colliders (the play space deepens to fit, and tap
    impulses scale with mass so shoves feel the same). Respawn re-spreads at
    the current scale with spacing adjusted so big bots start inside the walls.
  - `face camera` — off by default (full 3D tumbling). On: bots keep their
    face toward the viewer (no depth travel, spin only about the view axis).
  - `Respawn` — re-spreads all ten bots with new headings and reshuffled colors.

Works with touch on mobile; the panel starts collapsed on narrow screens.
Add `?lineup` to the URL to start the bots in one evenly spaced, upright row
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
- `src/canvas2d.ts` is the Canvas 2D fallback renderer described above, plus
  the trail snapshots and velocity-smear copies; `Scene.tsx` picks it when
  `detectWebGL()` fails or `?renderer=canvas2d` is set, hands the bots the
  lighter geometry set, and passes the effect sliders to it. Under WebGL the
  same sliders drive `WebGLTrail` (float-target fade-clear) and the ghost
  meshes in `Bot.tsx`.
- `src/Scene.tsx` sets up an orthographic camera looking down -Z, the six
  invisible walls at the viewport edges and a shallow front/back slab, the
  per-step speed normaliser, click handling and the Leva panel.
