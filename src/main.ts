import { Application, Assets, Container, Graphics, Sprite, type Texture } from "pixi.js";
import {
  decideGoal,
  formatClock,
  type Goal,
  type Needs,
  phaseOf,
  type Station,
  thoughtFor,
  tickNeeds,
} from "./sim";
import "./style.css";

// --- config ---------------------------------------------------------------

const WORLD = { w: 2400, h: 1500 };
const FENCE = 90; // inset of fence from world edge
const DAY_SECONDS = 300; // one full day
const SCALE = 3;

const HERD = [
  { name: "Trev", file: "trev", speed: 75, followsCamera: true },
  { name: "Bramble", file: "bramble", speed: 55, followsCamera: false },
  { name: "Willow", file: "willow", speed: 62, followsCamera: false },
];

const TREV_THOUGHTS = [
  "am I handsome? yes.",
  "snack? snack.",
  "that fence tickles.",
  "I am Trev. I wander.",
];

// --- boot -----------------------------------------------------------------
// NOTE: boot() must stay a plain (non-awaited) async call. Top-level await
// in this entry deadlocks Pixi's chunk cycle (entry <-> renderer chunks)
// with no error — the canvas just stays blank. Keep all awaits in here.

async function boot(): Promise<void> {
  const canvas = document.getElementById("scene") as HTMLCanvasElement;
  const thoughtEl = document.getElementById("thought") as HTMLDivElement;
  const clockEl = document.getElementById("clock") as HTMLDivElement;
  const followEl = document.getElementById("follow") as HTMLButtonElement;

  const app = new Application();
  await app.init({
    canvas,
    background: "#5d8f43",
    antialias: false,
    roundPixels: true,
    // Force WebGL: this sim needs nothing WebGPU-only, and WebGL works on
    // the widest range of phones/tablets.
    preference: "webgl",
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });

  function resize() {
    app.renderer.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", resize);
  resize();

  // Hold Space to fast-forward time (desktop). Tracks keys so the ticker
  // can scale the whole sim clock.
  const keysDown = new Set<string>();
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      keysDown.add("Space");
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") keysDown.delete("Space");
  });
  window.addEventListener("blur", () => keysDown.clear());

  // --- textures ---------------------------------------------------------------

  const base = import.meta.env.BASE_URL || "./";
  async function loadTex(name: string): Promise<Texture> {
    const t = (await Assets.load(`${base}assets/${name}`)) as Texture;
    const src = t.source as unknown as { scaleMode?: string };
    if (src) src.scaleMode = "nearest";
    return t;
  }

  const texNames: string[] = [];
  for (const h of HERD) {
    texNames.push(
      `${h.file}_walk0.png`,
      `${h.file}_walk1.png`,
      `${h.file}_idle.png`,
      `${h.file}_graze.png`,
      `${h.file}_drink.png`,
    );
  }
  texNames.push(
    "grass_0.png",
    "grass_1.png",
    "grass_dry.png",
    "fence_post.png",
    "water_bowl.png",
    "feed_tub.png",
    "bale_feeder.png",
    "hay_flake.png",
  );

  const tex: Record<string, Texture> = {};
  for (const n of texNames) tex[n] = await loadTex(n);

  // --- world ------------------------------------------------------------------

  const world = new Container();
  app.stage.addChild(world);
  // Two layers: flat ground is never depth-sorted, so grass can never cover
  // the fence. Everything upright (posts, tubs, horses, flakes) lives in
  // actors and is y-sorted each frame.
  const ground = new Container();
  const actors = new Container();
  world.addChild(ground, actors);

  // grass base
  const bg = new Graphics();
  bg.rect(0, 0, WORLD.w, WORLD.h).fill("#6fae4e");
  ground.addChild(bg);

  // scatter grass detail tiles (batched by texture, cheap)
  {
    const variants = ["grass_0.png", "grass_0.png", "grass_1.png", "grass_dry.png"];
    let seed = 42;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 260; i++) {
      const v = variants[Math.floor(rnd() * variants.length)];
      const s = new Sprite(tex[v]);
      s.scale.set(4);
      s.position.set(rnd() * (WORLD.w - 64), rnd() * (WORLD.h - 64));
      s.alpha = 0.9;
      ground.addChild(s);
    }
    // worn dirt near feeder + water
    const dirt = new Graphics();
    dirt.ellipse(1850, 1050, 190, 120).fill({ color: "#a08050", alpha: 0.55 });
    dirt.ellipse(1200, 170, 150, 60).fill({ color: "#9a7f52", alpha: 0.5 });
    dirt.ellipse(640, 620, 170, 100).fill({ color: "#9a7f52", alpha: 0.45 });
    ground.addChild(dirt);
  }

  // fence: metal posts + 3 electric rows
  {
    const wires = new Graphics();
    const x0 = FENCE;
    const y0 = FENCE;
    const x1 = WORLD.w - FENCE;
    const y1 = WORLD.h - FENCE;
    // 3 rows at different sprite heights (posts are 40px tall @1x, scaled 2x)
    const rows = [y0 + 18, y0 + 38, y0 + 58];
    const rowsB = [y1 - 58, y1 - 38, y1 - 18];
    wires.strokeStyle = { width: 2, color: "#f5f5f5", alpha: 0.9 };
    for (const ry of rows) {
      wires.moveTo(x0, ry).lineTo(x1, ry).stroke();
    }
    for (const ry of rowsB) {
      wires.moveTo(x0, ry).lineTo(x1, ry).stroke();
    }
    // vertical sides connect top row to bottom row heights
    for (const ry of [rows[0], rows[1], rows[2]]) {
      wires
        .moveTo(x0, ry)
        .lineTo(x0, y1 - (y0 + 76 - ry))
        .stroke();
      wires
        .moveTo(x1, ry)
        .lineTo(x1, y1 - (y0 + 76 - ry))
        .stroke();
    }
    ground.addChild(wires);

    const step = 150;
    const posts: Array<[number, number]> = [];
    for (let x = x0; x <= x1; x += step) {
      posts.push([x, y0]);
      posts.push([x, y1 - 76]);
    }
    for (let y = y0 + step; y < y1 - step; y += step) {
      posts.push([x0, y]);
      posts.push([x1 - 28, y]);
    }
    for (const [px, py] of posts) {
      const p = new Sprite(tex["fence_post.png"]);
      p.scale.set(2);
      p.position.set(px, py);
      actors.addChild(p);
    }
  }

  // stations
  const stations: Station[] = [
    { id: "graze-a", kind: "graze", x: 420, y: 1100 },
    { id: "graze-b", kind: "graze", x: 1500, y: 600 },
    { id: "graze-c", kind: "graze", x: 2050, y: 1250 },
    { id: "hay", kind: "hay", x: 1850, y: 1000 },
    { id: "feed-1", kind: "feed", x: 620, y: 590 },
    { id: "feed-2", kind: "feed", x: 720, y: 640 },
    { id: "water-1", kind: "water", x: 1200, y: 200 },
  ];

  function addStationSprite(x: number, y: number, png: string, sx = 3, sy = 3): Sprite {
    const s = new Sprite(tex[png]);
    s.anchor.set(0.5, 0.85);
    s.scale.set(sx, sy);
    s.position.set(x, y);
    s.eventMode = "static";
    s.cursor = "pointer";
    actors.addChild(s);
    return s;
  }

  const haySprite = addStationSprite(1850, 1050, "bale_feeder.png", 3, 3);
  const feedSprites = [
    addStationSprite(620, 610, "feed_tub.png", 3, 3),
    addStationSprite(720, 660, "feed_tub.png", 3, 3),
  ];
  const waterSprite = addStationSprite(1200, 190, "water_bowl.png", 3, 3);
  waterSprite.position.y = FENCE + 30;

  // graze markers: subtle darker tufts so goals read visually
  {
    const g = new Graphics();
    for (const st of stations.filter((s) => s.kind === "graze")) {
      g.ellipse(st.x, st.y, 90, 55).fill({ color: "#578a3b", alpha: 0.35 });
    }
    ground.addChild(g);
  }

  // --- horses -----------------------------------------------------------------

  // Tap (not drag) helper: records press point on pointerdown, fires only if
  // release lands within TAP_PX. Rotation-safe — Pixi hit-tests in
  // transformed space. Drags are handled by the canvas pan logic below.
  const TAP_PX = 12;
  function tap(sprite: Sprite, fn: () => void) {
    let dx = 0;
    let dy = 0;
    sprite.on("pointerdown", (e) => {
      dx = e.global.x;
      dy = e.global.y;
    });
    sprite.on("pointerup", (e) => {
      if (Math.hypot(e.global.x - dx, e.global.y - dy) < TAP_PX) fn();
    });
  }

  interface Horse {
    name: string;
    file: string;
    speed: number;
    sprite: Sprite;
    x: number;
    y: number;
    dir: 1 | -1;
    goal: Goal;
    needs: Needs;
    actionT: number; // seconds left doing graze/drink/eat/rest
    actionKind: Goal["kind"] | null;
    walkT: number;
    musingT: number;
  }

  const horses: Horse[] = HERD.map((h, i) => {
    const sprite = new Sprite(tex[`${h.file}_idle.png`]);
    sprite.anchor.set(0.5, 0.9);
    sprite.scale.set(SCALE * 1, SCALE);
    sprite.eventMode = "static";
    sprite.cursor = "pointer";
    const x = 500 + i * 260;
    const y = 500 + i * 180;
    sprite.position.set(x, y);
    actors.addChild(sprite);
    const horse: Horse = {
      name: h.name,
      file: h.file,
      speed: h.speed,
      sprite,
      x,
      y,
      dir: 1,
      goal: { stationId: null, kind: "wander", x: x + 200, y: y + 100 },
      needs: { hunger: 0.2 + i * 0.15, thirst: 0.2 + i * 0.1, energy: 0.9, boredom: 0.4 },
      actionT: 0,
      actionKind: null,
      walkT: Math.random() * 10,
      musingT: 4 + i * 5,
    };
    tap(sprite, () => onHorseTap(horse));
    return horse;
  });

  function setHorseFrame(h: Horse) {
    let suffix = "idle.png";
    if (h.actionKind === "graze" || h.actionKind === "hay" || h.actionKind === "feed") {
      suffix =
        h.actionKind === "feed" ? "graze.png" : h.actionKind === "hay" ? "graze.png" : "graze.png";
    } else if (h.actionKind === "water") {
      suffix = "drink.png";
    } else if (h.actionKind === "rest") {
      suffix = "idle.png";
    } else if (h.goal.kind === "wander" || moving(h)) {
      suffix = Math.floor(h.walkT * 4) % 2 === 0 ? "walk0.png" : "walk1.png";
    }
    const key = `${h.file}_${suffix}`;
    const t = tex[key] ?? tex[`${h.file}_idle.png`];
    if (h.sprite.texture !== t) h.sprite.texture = t;
    h.sprite.scale.x = SCALE * h.dir;
  }

  function moving(h: Horse): boolean {
    if (h.actionT > 0) return false;
    const dx = h.goal.x - h.x;
    const dy = h.goal.y - h.y;
    return Math.hypot(dx, dy) > 26;
  }

  function clampToPaddock(x: number, y: number): [number, number] {
    return [
      Math.min(WORLD.w - FENCE - 40, Math.max(FENCE + 40, x)),
      Math.min(WORLD.h - FENCE - 90, Math.max(FENCE + 100, y)),
    ];
  }

  // --- interaction --------------------------------------------------------------

  let activeHorse: Horse | null = null;
  let bubbleT = 0;
  // Camera: follows Trev until the user drags to pan. Chip button or
  // tapping Trev resumes the follow.
  let following = true;

  function showThought(h: Horse, text: string, secs = 4) {
    activeHorse = h;
    bubbleT = secs;
    thoughtEl.innerHTML = `<div class="bubble">${escapeHtml(text)}</div><div class="who">${escapeHtml(h.name.toUpperCase())}</div>`;
    thoughtEl.classList.add("show");
  }

  function escapeHtml(s: string): string {
    const ENTITIES: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
  }

  function onHorseTap(h: Horse) {
    const extra =
      h.name === "Trev" && Math.random() < 0.4
        ? TREV_THOUGHTS[Math.floor(Math.random() * TREV_THOUGHTS.length)]
        : thoughtFor(h.goal.kind === "wander" ? "wander" : (h.actionKind ?? "wander"));
    showThought(h, extra, 5);
    // tapping Trev resumes the camera follow — he is the main character
    if (h.name === "Trev") {
      following = true;
      for (const o of horses) {
        if (o !== h && Math.random() < 0.5) {
          o.goal = { stationId: null, kind: "wander", x: h.x + 80, y: h.y + 60 };
          o.actionT = 0;
          o.actionKind = null;
        }
      }
    }
  }

  function dropFeed(x: number, y: number) {
    const s = new Sprite(tex["hay_flake.png"]);
    s.anchor.set(0.5, 0.5);
    s.scale.set(3);
    s.position.set(x + (Math.random() - 0.5) * 40, y + 20);
    actors.addChild(s);
    // flakes fade after a while (eaten)
    setTimeout(() => {
      s.alpha = 0.4;
      setTimeout(() => s.parent?.removeChild(s), 4000);
    }, 12000);
  }

  for (const f of feedSprites) {
    tap(f, () => {
      dropFeed(f.position.x, f.position.y);
      for (const h of horses) {
        h.needs.hunger = Math.max(h.needs.hunger, 0.9);
        h.goal = { stationId: "feed-1", kind: "feed", x: f.position.x, y: f.position.y + 60 };
        h.actionT = 0;
        h.actionKind = null;
      }
      const trev = horses[0];
      showThought(trev, "HARD FEED!!!", 4);
    });
  }

  tap(waterSprite, () => {
    for (const h of horses) {
      h.needs.thirst = Math.max(h.needs.thirst, 0.85);
    }
    showThought(horses[0], "glug glug", 3);
  });

  tap(haySprite, () => {
    for (const h of horses) {
      h.needs.hunger = Math.max(h.needs.hunger, 0.8);
      if (Math.random() < 0.7) {
        h.goal = { stationId: "hay", kind: "hay", x: 1850, y: 1120 };
        h.actionT = 0;
        h.actionKind = null;
      }
    }
    showThought(horses[0], "hay!! the good stuff", 4);
  });

  // --- day cycle + camera ---------------------------------------------------------

  let dayT = 0.08; // start in the morning
  const cam = { x: 0, y: 0 };
  let camInit = false;

  const PHASE_ICON: Record<string, string> = {
    morning: "☀",
    midday: "☀",
    evening: "🌙",
    night: "🌙",
  };

  // Drag to pan (breaks the Trev follow); the follow chip resumes it.
  // Anchor-based so it works identically in the rotated portrait view.
  const DRAG_PX = 10;
  let panDown: { sx: number; sy: number; ax: number; ay: number } | null = null;
  let panning = false;
  canvas.addEventListener("pointerdown", (e) => {
    const a = world.toLocal({ x: e.clientX, y: e.clientY });
    panDown = { sx: e.clientX, sy: e.clientY, ax: a.x, ay: a.y };
    panning = false;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!panDown) return;
    if (!panning && Math.hypot(e.clientX - panDown.sx, e.clientY - panDown.sy) < DRAG_PX) return;
    panning = true;
    following = false;
    const cur = world.toLocal({ x: e.clientX, y: e.clientY });
    cam.x = clampCam(cam.x + (panDown.ax - cur.x), WORLD.w);
    cam.y = clampCam(cam.y + (panDown.ay - cur.y), WORLD.h);
  });
  const endPan = () => {
    panDown = null;
    panning = false;
  };
  canvas.addEventListener("pointerup", endPan);
  canvas.addEventListener("pointercancel", endPan);
  canvas.addEventListener("pointerleave", endPan);

  function clampCam(v: number, max: number): number {
    const m = 200; // margin of void allowed past the fence
    return Math.min(max + m, Math.max(-m, v));
  }

  followEl.addEventListener("click", (e) => {
    following = true;
    (e.currentTarget as HTMLButtonElement).blur(); // keep Space for fast-forward
  });

  let lastClock = "";
  function updateClock(fast: boolean) {
    const s = `${PHASE_ICON[phaseOf(dayT)]} ${formatClock(dayT)}${fast ? " »" : ""}`;
    if (s !== lastClock) {
      lastClock = s;
      clockEl.textContent = s;
    }
  }

  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1); // seconds (clamped)
    // Hold Space to fast-forward the whole sim clock.
    const fast = keysDown.has("Space");
    const sdt = fast ? dt * 10 : dt;
    dayT = (dayT + sdt / DAY_SECONDS) % 1;
    const phase = phaseOf(dayT);
    updateClock(fast);

    const dtMin = sdt * (1440 / DAY_SECONDS);

    for (const h of horses) {
      h.needs = tickNeeds(h.needs, dtMin, phase);

      if (h.actionT > 0) {
        h.actionT -= sdt;
        if (h.actionT <= 0) {
          // finished snacking/drinking/grazing — needs relieved
          if (h.actionKind === "water") h.needs.thirst = 0.08;
          if (h.actionKind === "feed" || h.actionKind === "hay" || h.actionKind === "graze") {
            h.needs.hunger = 0.08;
          }
          if (h.actionKind === "rest") h.needs.energy = Math.min(1, h.needs.energy + 0.25);
          h.needs.boredom = Math.max(0, h.needs.boredom - 0.2);
          h.actionKind = null;
          h.goal = decideGoal(h.needs, phase, stations, h.x, h.y);
          const [gx, gy] = clampToPaddock(h.goal.x, h.goal.y);
          h.goal.x = gx;
          h.goal.y = gy;
        }
      } else if (!moving(h)) {
        // arrived — start the action (or pick a new goal if just wandering)
        const g = h.goal;
        if (g.kind === "wander" || g.kind === "rest") {
          if (g.kind === "rest") {
            h.actionKind = "rest";
            h.actionT = 5;
          } else {
            h.needs.boredom = Math.max(0, h.needs.boredom - 0.15);
            h.goal = decideGoal(h.needs, phase, stations, h.x, h.y);
            const [gx, gy] = clampToPaddock(h.goal.x, h.goal.y);
            h.goal.x = gx;
            h.goal.y = gy;
          }
        } else {
          h.actionKind = g.kind;
          h.actionT = g.kind === "feed" ? 6 : g.kind === "water" ? 4 : 5 + Math.random() * 3;
        }
      } else {
        // walk toward goal
        const dx = h.goal.x - h.x;
        const dy = h.goal.y - h.y;
        const d = Math.hypot(dx, dy);
        const stepLen = h.speed * sdt;
        h.x += (dx / d) * Math.min(stepLen, d);
        h.y += (dy / d) * Math.min(stepLen, d);
        if (Math.abs(dx) > 4) h.dir = dx > 0 ? 1 : -1;
        h.walkT += sdt;
      }

      // idle musings — horses think things unprompted
      h.musingT -= sdt;
      if (h.musingT <= 0) {
        h.musingT = 9 + Math.random() * 14;
        if (!activeHorse || bubbleT <= 0) {
          const line =
            h.name === "Trev" && Math.random() < 0.35
              ? TREV_THOUGHTS[Math.floor(Math.random() * TREV_THOUGHTS.length)]
              : thoughtFor(h.actionKind ?? h.goal.kind);
          showThought(h, line, 3.5);
        }
      }

      const [cx, cy] = clampToPaddock(h.x, h.y);
      h.x = cx;
      h.y = cy;
      h.sprite.position.set(h.x, h.y);
      setHorseFrame(h);
    }

    // depth sort actors only: lower on screen = in front. Ground (grass,
    // fence wires) stays behind so it can never cover the fence.
    actors.children.sort((a, b) => a.position.y - b.position.y);

    // Camera: the longer screen dimension is always the horizontal. In
    // portrait the world renders sideways (-90°) so the paddock's long axis
    // runs along the phone's long edge — no rotate prompt needed.
    const trev = horses[0];
    const viewW = app.screen.width;
    const viewH = app.screen.height;
    const portrait = viewH > viewW;
    if (!camInit) {
      cam.x = trev.x;
      cam.y = trev.y;
      camInit = true;
    }
    if (following) {
      const k = Math.min(1, sdt * 2.5);
      cam.x += (trev.x - cam.x) * k;
      cam.y += (trev.y - cam.y) * k;
    }
    cam.x = clampCam(cam.x, WORLD.w);
    cam.y = clampCam(cam.y, WORLD.h);
    document.body.classList.toggle("portrait", portrait);
    world.rotation = portrait ? -Math.PI / 2 : 0;
    world.pivot.set(cam.x, cam.y);
    world.position.set(viewW / 2, viewH / 2);

    // thought bubble tracks the horse via the world transform, so it stays
    // glued in both orientations; hidden while the horse is off-screen
    if (activeHorse && bubbleT > 0) {
      bubbleT -= dt;
      const sp = world.toGlobal({ x: activeHorse.x, y: activeHorse.y - 150 });
      const onScreen = sp.x > 40 && sp.x < viewW - 40 && sp.y > 60 && sp.y < viewH - 20;
      if (onScreen) {
        thoughtEl.style.left = `${sp.x}px`;
        thoughtEl.style.top = `${sp.y}px`;
        thoughtEl.classList.add("show");
      } else {
        thoughtEl.classList.remove("show");
      }
      if (bubbleT <= 0) {
        thoughtEl.classList.remove("show");
        activeHorse = null;
      }
    } else {
      thoughtEl.classList.remove("show");
    }
  });

  updateClock(false);
  showThought(horses[0], "I am Trev. I wander.", 5);

  // Visual-test hook for scripted screenshots: horse world positions +
  // camera so tests can click exact targets.
  (window as unknown as Record<string, unknown>).__paddock = { horses, cam, WORLD };
}

boot().catch((err) => {
  console.error("boot failed", err);
  const el = document.getElementById("hint");
  if (el) el.textContent = "oh no — the paddock failed to load";
});
