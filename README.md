# Trev's Paddock

A 1-page Stardew-inspired 2D horse sim. Static frontend only, PixiJS canvas.

- **Trev** (chestnut colt, cropped mane, halter) wanders a scrolling paddock with
  Bramble and Willow (recolors).
- Horses graze, visit the round bale, snack hard feed from black tubs, drink
  from the green bowl, rest at night, and think things in bubbles.
- Drag to pan (camera follows Trev until you do; ◎ TREV resumes). Tap a horse
  to hear it. Tap a tub / bale / bowl to call the herd.
- Hold Space to fast-forward time; the clock shows paddock HH:MM.
- Any screen shape works: in portrait the world renders sideways so the long
  edge is always the horizontal.

## Run

```console
just run      # vite dev server (npm start)
just build    # sprites + tsc + static build to dist/
just check    # fast gate: prek builtin + biome + tsc
just manual   # everything check does, plus audit + unit tests
just test     # unit tests for sim scheduling (via prek)
just audit    # npm audit, read-only (via prek)
just ci       # manual + build — what CI runs
npm run fmt   # biome check --write over the repo
```

Deploy: `dist/` is published to Cloudflare Pages (see `.forgejo/workflows/ci.yml`).

## Layout

- `index.html` — Vite entry, HUD, follow chip
- `src/main.ts` — Pixi world, camera, horses, interaction
- `src/sim.ts` — pure needs/schedule logic (tested, no Pixi import)
- `src/style.css` — HUD + portrait-sideways rules
- `tools/generate-sprites.mjs` — zero-dep pixel-art PNG generator → `public/assets/`
- `tests/sim.test.ts` — `node --test` scheduling tests

## Visual checking (feedback loop)

Serve `dist/` and screenshot headlessly, then read the PNG:

```console
just build
npx vite preview --port 4174 --strictPort
firefox --headless --profile /tmp/opencode/ffprof \
  --screenshot=/tmp/opencode/paddock.png --window-size=1280,720 http://localhost:4174/
```

For clicks/console errors there are throwaway Playwright scripts in
`/tmp/opencode/shot/` (not committed — they depend on a local Chromium
cache). The game exposes `window.__paddock = { horses, cam, WORLD }` so
scripts can click exact horse positions.

Gotcha this loop caught: top-level `await` in the Vite entry deadlocks
Pixi's chunk cycle (entry ↔ renderer chunks) with no error — blank canvas.
All boot awaits must stay inside `boot()` (see the NOTE in `src/main.ts`).
