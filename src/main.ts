import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import {
  decideGoal,
  decodeSave,
  encodeSave,
  formatClock,
  type Goal,
  type HorseStats,
  type Needs,
  newStats,
  phaseOf,
  type SaveData,
  type Station,
  savourStats,
  skyAt,
  thoughtFor,
  tickNeeds,
  tickStats,
} from "./sim";
import "./style.css";

// --- config ---------------------------------------------------------------

// The property mirrors the satellite photo: Trev's paddock sits in the
// middle, with the dam bottom-right, arena and round yard to the east,
// Donnelly Ln along the top, and four big neighbour paddocks around it.
const WORLD = { w: 5200, h: 3400 };
const TREV_RECT = { x0: 1480, y0: 980, x1: 3700, y1: 2300 };
// North paddock runs further right than the others, matching the photo.
// The two west paddocks stay empty of horses.
const PADDOCKS = [
  { id: "north", x0: 1480, y0: 180, x1: 4800, y1: 850 },
  { id: "south", x0: 1480, y0: 2410, x1: 3700, y1: 3280 },
  { id: "west", x0: 150, y0: 980, x1: 1350, y1: 2300 },
  { id: "northwest", x0: 150, y0: 180, x1: 1350, y1: 850 },
];
const DAY_SECONDS = 300; // one full day
const SCALE = 3;
const ZMIN = 0.2;
const ZMAX = 2.5;

const HERD = [
  { name: "Trev", file: "trev", speed: 75 },
  { name: "Bramble", file: "bramble", speed: 55 },
  { name: "Willow", file: "willow", speed: 62 },
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
  const panelEl = document.getElementById("panel") as HTMLDivElement;
  const panelName = document.getElementById("panel-name") as HTMLSpanElement;
  const panelCounts = document.getElementById("panel-counts") as HTMLDivElement;
  const panelMeters: Record<string, HTMLElement> = {};
  for (const m of ["belly", "water", "rest", "fun", "social"]) {
    panelMeters[m] = document.getElementById(`m-${m}`) as HTMLElement;
  }

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
  // The sky listener is registered further down, once dayT and the shade
  // layer exist — see the "day/night lighting" section.

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

  // Saved stats live in localStorage so a refresh keeps every horse.
  // decodeSave validates: garbage in, null out.
  const SAVE_KEY = "trevs-paddock/save-v1";
  function loadSave(): SaveData | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? decodeSave(raw) : null;
    } catch {
      return null; // storage unavailable (private mode, etc.)
    }
  }
  function storeSave() {
    try {
      localStorage.setItem(SAVE_KEY, encodeSave(dayT, horses));
    } catch {
      /* best effort */
    }
  }
  const save = loadSave();

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
    "bale.png",
    "hay_flake.png",
    "tree.png",
    "shelter.png",
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
    for (let i = 0; i < 900; i++) {
      const v = variants[Math.floor(rnd() * variants.length)];
      const s = new Sprite(tex[v]);
      s.scale.set(4);
      s.position.set(rnd() * (WORLD.w - 64), rnd() * (WORLD.h - 64));
      s.alpha = 0.9;
      ground.addChild(s);
    }
    // worn dirt near feeder + tubs + water bowl
    const dirt = new Graphics();
    dirt.ellipse(1940, 1340, 190, 120).fill({ color: "#a08050", alpha: 0.55 });
    dirt.ellipse(3150, 1770, 170, 100).fill({ color: "#9a7f52", alpha: 0.45 });
    dirt.ellipse(1570, 1180, 150, 60).fill({ color: "#9a7f52", alpha: 0.5 });
    ground.addChild(dirt);
  }

  // fence: metal posts + 3 electric rows around one paddock rect
  function drawPaddockFence(x0: number, y0: number, x1: number, y1: number) {
    const wires = new Graphics();
    const rows = [y0 + 18, y0 + 38, y0 + 58];
    const rowsB = [y1 - 58, y1 - 38, y1 - 18];
    // 3 rows at different sprite heights (posts are 40px tall @1x, scaled 2x).
    // Width 3 + a soft under-glow: at 1px the wires moiré against the
    // grass and strobe as you zoom out.
    wires.strokeStyle = { width: 6, color: "#ffffff", alpha: 0.18 };
    for (const ry of rows) {
      wires.moveTo(x0, ry).lineTo(x1, ry).stroke();
    }
    for (const ry of rowsB) {
      wires.moveTo(x0, ry).lineTo(x1, ry).stroke();
    }
    wires.strokeStyle = { width: 3, color: "#f5f5f5", alpha: 0.95 };
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

  drawPaddockFence(TREV_RECT.x0, TREV_RECT.y0, TREV_RECT.x1, TREV_RECT.y1);
  for (const p of PADDOCKS) drawPaddockFence(p.x0, p.y0, p.x1, p.y1);

  // --- the rest of the property (from the satellite photo) ------------------
  {
    // dam, bottom-right: muddy rim + dark water
    const dam = new Graphics();
    dam.ellipse(4450, 3080, 280, 190).fill("#5d6b48");
    dam.ellipse(4450, 3075, 230, 150).fill("#243b6b");
    dam.ellipse(4500, 3060, 120, 70).fill({ color: "#2f4d80", alpha: 0.6 });
    ground.addChild(dam);

    // sand arena, east side: pale footing + white rails
    const arena = new Graphics();
    arena.rect(4400, 2350, 650, 350).fill("#cbb37f");
    arena.rect(4400, 2350, 650, 350).stroke({ width: 6, color: "#e8e2d0" });
    arena.rect(4420, 2370, 610, 310).fill({ color: "#c2a878", alpha: 0.6 });
    ground.addChild(arena);

    // round yard: dark rail ring on grass
    const yard = new Graphics();
    yard.circle(4725, 2000, 140).stroke({ width: 10, color: "#3d3227" });
    yard.circle(4725, 2000, 128).stroke({ width: 3, color: "#5a4a38" });
    ground.addChild(yard);

    // Donnelly Ln along the top
    const road = new Graphics();
    road.rect(0, 60, WORLD.w, 80).fill("#c9b183");
    road.rect(0, 60, WORLD.w, 8).fill("#b39a6b");
    road.rect(0, 132, WORLD.w, 8).fill("#b39a6b");
    ground.addChild(road);
    const roadLabel = new Text({
      text: "Donnelly Ln",
      style: { fontFamily: "Trebuchet MS, Verdana, sans-serif", fontSize: 44, fill: "#fff8e6" },
    });
    roadLabel.anchor.set(0.5, 0.5);
    roadLabel.position.set(900, 100);
    ground.addChild(roadLabel);

    // trees: dam cluster, the row along the top of Trev's paddock, singles
    const treeSpots: Array<[number, number, number]> = [
      [4750, 3200, 3],
      [4600, 3260, 2.6],
      [4300, 3220, 3.2],
      [4150, 3050, 2.4],
      [4700, 2950, 2.8],
      [4250, 2920, 2.2],
      [4850, 3050, 2.5],
      [4050, 3150, 2.9],
      [4300, 1600, 2.6],
      [1000, 2500, 3],
      [600, 800, 2.4],
      [5000, 1200, 2.8],
      [1800, 500, 2.2],
      [4300, 2900, 2.5],
      [2700, 400, 2.7],
      [5100, 2500, 2.3],
      [450, 450, 3],
      [300, 350, 2.6],
      [550, 300, 2.4],
      [250, 550, 2.8],
      [5050, 1850, 2.5],
      [4920, 1700, 2.2],
      [5080, 1550, 2.7],
    ];
    for (let x = 1600; x <= 3600; x += 200) treeSpots.push([x, 915, 1.6]);
    for (const [tx, ty, ts] of treeSpots) {
      const t = new Sprite(tex["tree.png"]);
      t.anchor.set(0.5, 0.9);
      t.scale.set(ts);
      t.position.set(tx, ty);
      actors.addChild(t);
    }
  }

  // stations (Trev's paddock + one graze patch or two per neighbour paddock).
  // Water bowl hangs top-left on the left fence; the horse drinks just inside.
  const trevStations: Station[] = [
    { id: "graze-a", kind: "graze", x: 3370, y: 1290 },
    { id: "graze-b", kind: "graze", x: 2290, y: 1790 },
    { id: "graze-c", kind: "graze", x: 1740, y: 1140 },
    { id: "hay", kind: "hay", x: 1940, y: 1390 },
    { id: "feed-1", kind: "feed", x: 3170, y: 1800 },
    { id: "feed-2", kind: "feed", x: 3070, y: 1750 },
    { id: "water-1", kind: "water", x: 1600, y: 1150 },
  ];
  // Graze spots + a hay spot (round bale) for every neighbour paddock.
  // PADDOCKS order is north, south, west, northwest — the west two stay empty.
  const neighbourSpots: Station[][] = [
    [
      { id: "north-graze-a", kind: "graze", x: 3000, y: 600 },
      { id: "north-graze-b", kind: "graze", x: 2100, y: 400 },
      { id: "north-hay", kind: "hay", x: 4300, y: 560 },
    ],
    [
      { id: "south-graze-a", kind: "graze", x: 3200, y: 2900 },
      { id: "south-graze-b", kind: "graze", x: 2000, y: 2700 },
      { id: "south-hay", kind: "hay", x: 2100, y: 3110 },
    ],
    [
      { id: "west-graze-a", kind: "graze", x: 1000, y: 1900 },
      { id: "west-graze-b", kind: "graze", x: 500, y: 1400 },
      { id: "west-hay", kind: "hay", x: 800, y: 1810 },
    ],
    [
      { id: "northwest-graze-a", kind: "graze", x: 800, y: 500 },
      { id: "northwest-hay", kind: "hay", x: 700, y: 710 },
    ],
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

  // Round bales in every paddock, set just above each "hay" station so the
  // horse walks to the bale. Trev's is the one in the metal ring feeder.
  for (const hay of neighbourSpots.flat().filter((s) => s.kind === "hay")) {
    addStationSprite(hay.x, hay.y - 40, "bale.png", 2.4, 2.4);
  }

  // Metal field shelters in the north paddock. Three along the top, plus one
  // in the bottom-left corner turned on the diagonal so it faces the corner.
  for (const [sx, sy] of [
    [2100, 300],
    [2500, 300],
    [4200, 300],
  ] as Array<[number, number]>) {
    const sh = new Sprite(tex["shelter.png"]);
    sh.anchor.set(0.5, 0.9);
    sh.scale.set(2.2);
    sh.position.set(sx, sy);
    actors.addChild(sh);
  }
  {
    // Turned on the diagonal, tucked against the bottom-left corner inside
    // the fence. Scaled down a touch so it reads as "in the corner" rather
    // than poking through the wire.
    const corner = new Sprite(tex["shelter.png"]);
    corner.anchor.set(0.5, 0.5);
    corner.scale.set(1.8);
    corner.rotation = -Math.PI / 4;
    corner.position.set(PADDOCKS[0].x0 + 210, PADDOCKS[0].y1 - 150);
    actors.addChild(corner);
  }

  const haySprite = addStationSprite(1940, 1340, "bale_feeder.png", 3, 3);
  const feedSprites = [
    addStationSprite(3170, 1780, "feed_tub.png", 3, 3),
    addStationSprite(3070, 1730, "feed_tub.png", 3, 3),
  ];
  const waterSprite = addStationSprite(1495, 1120, "water_bowl.png", 3, 3);

  // graze markers: subtle darker tufts so goals read visually
  {
    const g = new Graphics();
    for (const st of [...trevStations, ...neighbourSpots.flat()].filter(
      (s) => s.kind === "graze",
    )) {
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

  interface Bounds {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
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
    bounds: Bounds;
    spots: Station[];
    stats: HorseStats;
    actionT: number; // seconds left doing graze/drink/eat/rest
    actionKind: Goal["kind"] | null;
    walkT: number;
    musingT: number;
  }

  const trevBounds: Bounds = {
    x0: TREV_RECT.x0 + 40,
    y0: TREV_RECT.y0 + 100,
    x1: TREV_RECT.x1 - 40,
    y1: TREV_RECT.y1 - 90,
  };

  function makeHorse(
    name: string,
    file: string,
    speed: number,
    x: number,
    y: number,
    bounds: Bounds,
    spots: Station[],
    musingDelay: number,
  ): Horse {
    const sprite = new Sprite(tex[`${file}_idle.png`]);
    sprite.anchor.set(0.5, 0.9);
    sprite.scale.set(SCALE, SCALE);
    sprite.eventMode = "static";
    sprite.cursor = "pointer";
    sprite.position.set(x, y);
    actors.addChild(sprite);
    const saved = save?.horses[name];
    const sx = saved && Number.isFinite(saved.x) ? saved.x : x;
    const sy = saved && Number.isFinite(saved.y) ? saved.y : y;
    const horse: Horse = {
      name,
      file,
      speed,
      sprite,
      x: sx,
      y: sy,
      dir: 1,
      goal: { stationId: null, kind: "wander", x: sx + 200, y: sy + 100 },
      needs: saved?.needs ?? { hunger: 0.2, thirst: 0.2, energy: 0.9, boredom: 0.4 },
      bounds,
      spots,
      stats: saved?.stats ?? newStats(),
      actionT: 0,
      actionKind: null,
      walkT: Math.random() * 10,
      musingT: musingDelay,
    };
    tap(sprite, () => onHorseTap(horse));
    return horse;
  }

  function paddockBounds(i: number) {
    const p = PADDOCKS[i];
    return { x0: p.x0 + 40, y0: p.y0 + 100, x1: p.x1 - 40, y1: p.y1 - 90 };
  }

  // Trev has the middle paddock to himself.
  const trev = makeHorse("Trev", "trev", 75, 3290, 1890, trevBounds, trevStations, 4);

  // Bramble and Willow live in the paddock directly below Trev's.
  const southHerd = [
    { name: "Bramble", file: "bramble", speed: 55, x: 3000, y: 2950 },
    { name: "Willow", file: "willow", speed: 62, x: 2600, y: 2750 },
  ].map((h, i) =>
    makeHorse(h.name, h.file, h.speed, h.x, h.y, paddockBounds(1), neighbourSpots[1], 6 + i * 5),
  );

  // The four horses above Trev, all in the north paddock. The two west
  // paddocks are deliberately empty.
  const northHerd = [
    { name: "Jasper", file: "bramble", speed: 55, x: 2400, y: 620 },
    { name: "Pip", file: "willow", speed: 62, x: 3000, y: 480 },
    { name: "Mabel", file: "trev", speed: 58, x: 3600, y: 640 },
    { name: "Rusty", file: "bramble", speed: 52, x: 4200, y: 500 },
  ].map((h, i) =>
    makeHorse(h.name, h.file, h.speed, h.x, h.y, paddockBounds(0), neighbourSpots[0], 8 + i * 4),
  );

  const horses = [trev, ...southHerd, ...northHerd];

  function setHorseFrame(h: Horse) {
    let suffix = "idle.png";
    if (h.actionKind === "graze" || h.actionKind === "hay" || h.actionKind === "feed") {
      suffix = "graze.png";
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

  // Horses never leave their own paddock, fences or no fences.
  function clampToBounds(h: Horse, x: number, y: number): [number, number] {
    return [
      Math.min(h.bounds.x1, Math.max(h.bounds.x0, x)),
      Math.min(h.bounds.y1, Math.max(h.bounds.y0, y)),
    ];
  }

  // --- interaction --------------------------------------------------------------

  let activeHorse: Horse | null = null;
  let bubbleT = 0;
  let selected: Horse | null = null;
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
    selected = h;
    const extra =
      h.name === "Trev" && Math.random() < 0.4
        ? TREV_THOUGHTS[Math.floor(Math.random() * TREV_THOUGHTS.length)]
        : thoughtFor(h.goal.kind === "wander" ? "wander" : (h.actionKind ?? "wander"));
    showThought(h, extra, 5);
    // tapping Trev resumes the camera follow — he is the main character
    if (h.name === "Trev") following = true;
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

  const feedIds = ["feed-1", "feed-2"];
  for (const [i, f] of feedSprites.entries()) {
    tap(f, () => {
      dropFeed(f.position.x, f.position.y);
      trev.needs.hunger = Math.max(trev.needs.hunger, 0.9);
      trev.goal = { stationId: feedIds[i], kind: "feed", x: f.position.x, y: f.position.y + 60 };
      trev.actionT = 0;
      trev.actionKind = null;
      showThought(trev, "HARD FEED!!!", 4);
    });
  }

  tap(waterSprite, () => {
    trev.needs.thirst = Math.max(trev.needs.thirst, 0.85);
    showThought(trev, "glug glug", 3);
  });

  tap(haySprite, () => {
    trev.needs.hunger = Math.max(trev.needs.hunger, 0.8);
    trev.goal = { stationId: "hay", kind: "hay", x: 1940, y: 1270 };
    trev.actionT = 0;
    trev.actionKind = null;
    showThought(trev, "hay!! the good stuff", 4);
  });

  // --- day cycle + camera ---------------------------------------------------------

  let dayT = save?.dayT ?? 0.08; // resume where we left off, else morning
  const cam = { x: 0, y: 0 };
  let camInit = false;

  const PHASE_ICON: Record<string, string> = {
    sunrise: "🌅",
    morning: "☀",
    midday: "☀",
    evening: "🌇",
    sunset: "🌇",
    twilight: "🌆",
    night: "🌙",
  };

  // Drag to pan (breaks the Trev follow); the follow chip resumes it.
  // Anchor-based so it works identically in the rotated portrait view.
  const DRAG_PX = 10;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; mx: number; my: number } | null = null;
  let zoom = 1;
  let panDown: { sx: number; sy: number; ax: number; ay: number } | null = null;
  let panning = false;
  canvas.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // second finger down: switch from pan to pinch
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
      panDown = null;
      panning = false;
      return;
    }
    const a = world.toLocal({ x: e.clientX, y: e.clientY });
    panDown = { sx: e.clientX, sy: e.clientY, ax: a.x, ay: a.y };
    panning = false;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (dist > 0 && pinch.dist > 0) {
        // zoom about the midpoint, then slide with it — all through the
        // world transform so portrait rotation just works
        const anchor = world.toLocal({ x: pinch.mx, y: pinch.my });
        zoom = clampZoom(zoom * (dist / pinch.dist));
        applyView();
        world.updateTransform({});
        const held = world.toLocal({ x: mx, y: my });
        cam.x = clampCam(cam.x + (anchor.x - held.x), WORLD.w);
        cam.y = clampCam(cam.y + (anchor.y - held.y), WORLD.h);
        applyView();
      }
      pinch = { dist, mx, my };
      following = false;
      return;
    }
    if (!panDown) return;
    if (!panning && Math.hypot(e.clientX - panDown.sx, e.clientY - panDown.sy) < DRAG_PX) return;
    panning = true;
    following = false;
    const cur = world.toLocal({ x: e.clientX, y: e.clientY });
    cam.x = clampCam(cam.x + (panDown.ax - cur.x), WORLD.w);
    cam.y = clampCam(cam.y + (panDown.ay - cur.y), WORLD.h);
  });
  const endPan = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      // back to one finger: re-anchor the pan so it doesn't jump
      const remaining = [...pointers.values()][0];
      const a = world.toLocal({ x: remaining.x, y: remaining.y });
      panDown = { sx: remaining.x, sy: remaining.y, ax: a.x, ay: a.y };
      panning = false;
    } else {
      panDown = null;
      panning = false;
    }
  };
  canvas.addEventListener("pointerup", endPan);
  canvas.addEventListener("pointercancel", endPan);
  canvas.addEventListener("pointerleave", endPan);

  function clampCam(v: number, max: number): number {
    const m = 200; // margin of void allowed past the fence
    return Math.min(max + m, Math.max(-m, v));
  }

  function clampZoom(z: number): number {
    return Math.min(ZMAX, Math.max(ZMIN, z));
  }

  // Push cam/zoom/orientation into the world transform. Handlers call
  // world.updateTransform() after this when they need fresh toLocal/toGlobal.
  function applyView() {
    const viewW = app.screen.width;
    const viewH = app.screen.height;
    const portrait = viewH > viewW;
    document.body.classList.toggle("portrait", portrait);
    world.rotation = portrait ? -Math.PI / 2 : 0;
    world.scale.set(zoom);
    world.pivot.set(cam.x, cam.y);
    world.position.set(viewW / 2, viewH / 2);
  }

  // --- day/night lighting ----------------------------------------------------
  // Two layers: a warm/cool tint on the world (multiply-ish, so the pixel
  // art keeps its colours), then a screen-space darkening pass that is
  // unaffected by zoom or the portrait rotation. A moon/sun marker rides
  // across the sky so you can see the time pass.
  const NIGHT_COLOR = 0x0a1030;
  // World-space lantern positions: the shelter, the feeder, the ring feeder,
  // and the water bowl. Warm barn light, so they read as lamps not floodlights.
  const LIGHTS: Array<[number, number, number, number]> = [
    [2100, 300, 190, 0xffd9a0],
    [2500, 300, 190, 0xffd9a0],
    [4200, 300, 190, 0xffd9a0],
    [1660, 780, 150, 0xffe3b0],
    [1940, 1340, 170, 0xffe0aa],
    [3100, 1770, 165, 0xffdcae],
    [2610, 1130, 165, 0xcfe4ff],
  ];
  const darkness = new Graphics();
  darkness.eventMode = "none";
  app.stage.addChild(darkness);
  const shade = new Sprite(Texture.WHITE);
  shade.eventMode = "none";
  shade.tint = NIGHT_COLOR;
  shade.alpha = 0;
  darkness.addChild(shade);

  const bodyGlow = new Graphics();
  bodyGlow.eventMode = "none";
  darkness.addChild(bodyGlow);

  const sun = new Graphics();
  sun.eventMode = "none";
  darkness.addChild(sun);

  // Registered here, not next to the initial resize: a resize that lands
  // while boot() is still loading textures would call applySky() before
  // dayT and the shade layer are initialised, throwing a TDZ ReferenceError
  // that silently kills the rest of boot.
  window.addEventListener("resize", applySky);

  // Called every frame and on resize; the shade rect is resized to match the
  // viewport and the glow circles are re-stacked at the new light positions.
  function applySky() {
    const sky = skyAt(dayT);
    shade.width = app.screen.width;
    shade.height = app.screen.height;
    shade.position.set(0, 0);
    world.tint = sky.tint;

    // Ambient is deliberately shallow: the world tint already carries most of
    // the darkening, so a heavy overlay on top would crush the horses to
    // silhouettes. Night should read as night, not as an unreadable screen.
    const a = sky.ambient;
    shade.alpha = a * 0.42;
    darkness.blendMode = "normal";

    // Lantern glow, anchored to world points so it moves with the camera and
    // tightens when you zoom in. Each light is stacked faint circles so the
    // falloff is soft instead of a visible disc edge.
    bodyGlow.clear();
    bodyGlow.blendMode = "add";
    if (a > 0.35) {
      const k = (a - 0.35) / 0.65;
      for (const [wx, wy, wr, lc] of LIGHTS) {
        const g = world.toGlobal({ x: wx, y: wy });
        const r = Math.min(Math.max(app.screen.width, app.screen.height) * 0.26, wr * zoom * 2.4);
        for (const [mult, alpha] of [
          [1.0, 0.05],
          [0.62, 0.055],
          [0.34, 0.06],
          [0.16, 0.07],
        ] as Array<[number, number]>) {
          bodyGlow.circle(g.x, g.y, r * mult).fill({ color: lc, alpha: alpha * k });
        }
      }
    }

    // Sun / moon arc: x tracks the time of day, y is a shallow arc.
    const t = ((dayT % 1) + 1) % 1;
    const isDay = t > 0.05 && t < 0.72;
    const arc = Math.sin(((t - 0.05) / 0.67) * Math.PI); // 0 at the ends
    const w = app.screen.width;
    const h = app.screen.height;
    const sx = w * (0.08 + 0.84 * ((t - 0.05) / 0.67));
    const sy = h * (0.72 - arc * 0.5);
    sun.clear();
    sun.blendMode = "add";
    if (isDay) {
      sun.circle(sx, sy, 26).fill({ color: 0xfff2b0, alpha: 0.5 });
      sun.circle(sx, sy, 15).fill({ color: 0xfffbe0, alpha: 0.75 });
    } else if (a > 0.4) {
      sun.circle(sx, sy, 20).fill({ color: 0xdfe6ff, alpha: 0.35 });
      sun.circle(sx, sy, 11).fill({ color: 0xf4f7ff, alpha: 0.7 });
    }
    return sky;
  }

  // Zoom keeping the world point under (sx, sy) fixed.
  function zoomAt(sx: number, sy: number, f: number) {
    const before = world.toLocal({ x: sx, y: sy });
    zoom = clampZoom(zoom * f);
    applyView();
    world.updateTransform({});
    const after = world.toLocal({ x: sx, y: sy });
    cam.x = clampCam(cam.x + (before.x - after.x), WORLD.w);
    cam.y = clampCam(cam.y + (before.y - after.y), WORLD.h);
    applyView();
    world.updateTransform({});
  }

  // Scroll to zoom (trackpad pinch sends wheel too). Keeps the follow:
  // zooming is looking, not leaving.
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

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

  // Stats card for the tapped horse, refreshed 4x a second. Bars are
  // fulfilment (full = good), coloured red-green by value.
  document.getElementById("panel-x")?.addEventListener("click", (e) => {
    selected = null;
    (e.currentTarget as HTMLButtonElement).blur();
  });
  let panelT = 0;
  function setMeter(key: string, v: number) {
    const el = panelMeters[key];
    el.style.width = `${Math.round(v * 100)}%`;
    el.style.background = `hsl(${Math.round(v * 120)}, 65%, 45%)`;
  }
  function renderPanel(dt: number) {
    panelT -= dt;
    if (panelT > 0) return;
    panelT = 0.25;
    const h = selected;
    if (!h) {
      panelEl.classList.add("hidden");
      return;
    }
    panelEl.classList.remove("hidden");
    if (panelName.textContent !== h.name.toUpperCase()) {
      panelName.textContent = h.name.toUpperCase();
    }
    setMeter("belly", 1 - h.needs.hunger);
    setMeter("water", 1 - h.needs.thirst);
    setMeter("rest", h.needs.energy);
    setMeter("fun", h.stats.fun);
    setMeter("social", h.stats.social);
    const s = h.stats;
    panelCounts.textContent =
      `${s.treats} treats · ${s.drinks} drinks · ${s.naps} naps · ` +
      `${Math.round(s.distance / 50)} m wandered`;
  }

  // Persist every few seconds and on hide/close — refresh keeps everyone.
  setInterval(storeSave, 5000);
  window.addEventListener("pagehide", storeSave);

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
      const nearOthers = horses.some((o) => o !== h && Math.hypot(o.x - h.x, o.y - h.y) < 300);
      h.stats = tickStats(h.stats, dtMin, nearOthers);

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
          if (h.actionKind) h.stats = savourStats(h.stats, h.actionKind);
          h.actionKind = null;
          h.goal = decideGoal(h.needs, phase, h.spots, h.x, h.y);
          const [gx, gy] = clampToBounds(h, h.goal.x, h.goal.y);
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
            h.goal = decideGoal(h.needs, phase, h.spots, h.x, h.y);
            const [gx, gy] = clampToBounds(h, h.goal.x, h.goal.y);
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
        const stride = Math.min(stepLen, d);
        h.x += (dx / d) * stride;
        h.y += (dy / d) * stride;
        h.stats = { ...h.stats, distance: h.stats.distance + stride };
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

      const [cx, cy] = clampToBounds(h, h.x, h.y);
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
    const viewW = app.screen.width;
    const viewH = app.screen.height;
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
    applyView();
    const sky = applySky();
    dbg.zoom = zoom;
    dbg.tint = sky.tint;
    dbg.ambient = sky.ambient;

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

    renderPanel(dt);
  });

  updateClock(false);
  selected = trev;
  showThought(trev, "I am Trev. I wander.", 5);

  // Visual-test hook for scripted screenshots: horse world positions +
  // camera so tests can click exact targets.
  const dbg = {
    horses,
    trev,
    southHerd,
    northHerd,
    cam,
    WORLD,
    zoom: 1,
    tint: 0,
    ambient: 0,
    // Day-cycle control for visual tests / screenshots.
    setDayT: (v: number) => {
      dayT = v;
    },
  };
  (window as unknown as Record<string, unknown>).__paddock = dbg;
}

boot().catch((err) => {
  console.error("boot failed", err);
  const el = document.getElementById("hint");
  if (el) el.textContent = "oh no — the paddock failed to load";
});
