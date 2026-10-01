// Pure paddock simulation logic — no Pixi imports so node --test can run it.
// Horses have needs (0..1, 1 = urgent). A day schedule biases them.
// decideGoal() is deterministic given inputs; movement/thoughts live in main.ts.

export type StationKind = "graze" | "hay" | "feed" | "water";

export interface Station {
  id: string;
  kind: StationKind;
  x: number;
  y: number;
}

export interface Needs {
  hunger: number; // drives graze / hay / feed
  thirst: number; // drives water
  energy: number; // 1 = rested; low at night -> rest
  boredom: number; // drives wander / visiting herd
}

export type Phase = "night" | "sunrise" | "morning" | "midday" | "evening" | "sunset" | "twilight";

// Keyframes around the cycle. dayT 0 = 06:00 and a full day = 24h, so 0.01 of
// dayT is 14.4 minutes. Times are chosen so the clock reads correctly:
// sunrise ~06:00, sunset ~18:00, twilight ~19:00, full dark from ~20:00.
// The final key repeats the t=0 values exactly so the wrap is seamless.
const SKY_KEYS: Array<{ t: number; phase: Phase; tint: number; ambient: number }> = [
  { t: 0.0, phase: "sunrise", tint: 0xffb877, ambient: 0.38 }, //  06:00
  { t: 0.042, phase: "morning", tint: 0xfff4e0, ambient: 0.08 }, //  07:00
  { t: 0.21, phase: "midday", tint: 0xffffff, ambient: 0.0 }, //  11:00
  { t: 0.375, phase: "midday", tint: 0xffffff, ambient: 0.0 }, //  15:00
  { t: 0.458, phase: "evening", tint: 0xfff0d0, ambient: 0.08 }, //  17:00
  { t: 0.5, phase: "sunset", tint: 0xff9a5c, ambient: 0.3 }, //  18:00
  { t: 0.542, phase: "twilight", tint: 0x9a86c4, ambient: 0.46 }, //  19:00
  { t: 0.583, phase: "night", tint: 0x6d7aa8, ambient: 0.6 }, //  20:00
  { t: 0.79, phase: "night", tint: 0x5a689a, ambient: 0.66 }, //  01:00
  { t: 0.92, phase: "night", tint: 0x66739f, ambient: 0.58 }, //  04:00
  // Must equal the t=0 sunrise ambient exactly or the wrap pops.
  { t: 1.0, phase: "sunrise", tint: 0xffb877, ambient: 0.38 }, //  06:00
];

const wrap01 = (v: number) => ((v % 1) + 1) % 1;

export interface Sky {
  phase: Phase;
  /** Multiplicative tint applied to the whole world. */
  tint: number;
  /** 0 = full daylight, 1 = deepest night. Drives the dark overlay. */
  ambient: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Interpolate the two neighbouring keyframes; night keys at both ends so the
// wrap from 1.0 back to 0.0 stays continuous.
export function skyAt(dayT: number): Sky {
  const t = wrap01(dayT);
  let prev = SKY_KEYS[SKY_KEYS.length - 1];
  let next = SKY_KEYS[0];
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    if (t >= SKY_KEYS[i].t && t <= SKY_KEYS[i + 1].t) {
      prev = SKY_KEYS[i];
      next = SKY_KEYS[i + 1];
      break;
    }
  }
  const span = next.t - prev.t || 1;
  const f = (t - prev.t) / span;
  const cl = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  const tint =
    (cl(lerp((prev.tint >> 16) & 255, (next.tint >> 16) & 255, f)) << 16) |
    (cl(lerp((prev.tint >> 8) & 255, (next.tint >> 8) & 255, f)) << 8) |
    cl(lerp(prev.tint & 255, next.tint & 255, f));
  return {
    phase: f < 0.5 ? prev.phase : next.phase,
    tint,
    ambient: lerp(prev.ambient, next.ambient, f),
  };
}

export function phaseOf(dayT: number): Phase {
  return skyAt(dayT).phase;
}

// Wall-clock for the HUD: dayT 0 = 06:00 dawn, so morning=06-12,
// midday=12-18, evening=18-24, night=00-06. No date, just HH:MM.
export function formatClock(dayT: number): string {
  const t = ((dayT % 1) + 1) % 1; // wrap into [0,1)
  const hour = (6 + t * 24) % 24;
  const h = Math.floor(hour);
  const m = Math.floor((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface Goal {
  stationId: string | null; // null = wander nearby
  kind: StationKind | "wander" | "rest";
  x: number;
  y: number;
}

// Rest happens in the dark half: twilight through to the end of sunrise.
function isDark(phase: Phase): boolean {
  return phase === "night" || phase === "twilight" || phase === "sunrise";
}

export function tickNeeds(n: Needs, dtMin: number, phase: Phase): Needs {
  // dtMin: in-game minutes elapsed.
  const hungerRate = isDark(phase) ? 0.004 : 0.012;
  const thirstRate = phase === "midday" ? 0.02 : 0.01;
  const boredomRate = 0.008;
  const drain = (v: number, r: number) => Math.min(1, Math.max(0, v + r * dtMin));
  const energy = isDark(phase)
    ? Math.min(1, n.energy + 0.02 * dtMin)
    : Math.max(0, n.energy - 0.004 * dtMin);
  return {
    hunger: drain(n.hunger, hungerRate),
    thirst: drain(n.thirst, thirstRate),
    boredom: drain(n.boredom, boredomRate),
    energy,
  };
}

export function decideGoal(
  n: Needs,
  phase: Phase,
  stations: Station[],
  hx: number,
  hy: number,
  rand: () => number = Math.random,
): Goal {
  const byKind = (k: StationKind) => stations.filter((s) => s.kind === k);
  const nearest = (list: Station[]): Station | null => {
    if (list.length === 0) return null;
    let best = list[0];
    let bd = (best.x - hx) ** 2 + (best.y - hy) ** 2;
    for (const s of list.slice(1)) {
      const d = (s.x - hx) ** 2 + (s.y - hy) ** 2;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  };

  // After dark: rest where you stand unless very thirsty.
  if (isDark(phase) && n.energy < 0.7 && n.thirst < 0.75) {
    return { stationId: null, kind: "rest", x: hx, y: hy };
  }
  // Urgent thirst beats everything.
  if (n.thirst > 0.65) {
    const w = nearest(byKind("water"));
    if (w) return { stationId: w.id, kind: "water", x: w.x, y: w.y };
  }
  // Hunger: pick station by severity. Hard feed tub is a treat (rare pick
  // unless very hungry or a feed drop just happened — caller boosts hunger).
  if (n.hunger > 0.55) {
    const roll = rand();
    const pool: StationKind[] =
      n.hunger > 0.85
        ? ["feed", "hay", "graze", "graze"]
        : roll < 0.25
          ? ["hay", "graze", "graze"]
          : ["graze", "graze", "hay"];
    for (const k of pool) {
      const s = nearest(byKind(k));
      if (s) return { stationId: s.id, kind: k, x: s.x, y: s.y };
    }
  }
  // Bored: go visit a random station (herd mixing).
  if (n.boredom > 0.5 && rand() < 0.6 && stations.length > 0) {
    const s = stations[Math.floor(rand() * stations.length)];
    return { stationId: s.id, kind: s.kind, x: s.x, y: s.y };
  }
  // Default: wander nearby.
  const a = rand() * Math.PI * 2;
  const r = 120 + rand() * 220;
  return { stationId: null, kind: "wander", x: hx + Math.cos(a) * r, y: hy + Math.sin(a) * r };
}

// Keyed by Goal["kind"], so a new goal kind that has no line is a type error
// here rather than a silent fallback at runtime.
const THOUGHTS: Record<Goal["kind"], string[]> = {
  wander: [
    "la la la",
    "nice grass today",
    "patrol. patrol.",
    "do I smell hay?",
    "legs. legs. legs.",
  ],
  graze: ["nom. nom.", "this patch. this one.", "grass is grass"],
  hay: ["hay!! the good stuff", "crunch crunch", "round bale supremacy"],
  feed: ["HARD FEED!!!", "oh YES treats", "crunchy. salty. mine."],
  water: ["glug glug", "ahhh", "hydrated. powerful."],
  rest: ["z z z", "…", "do not. perceive me."],
};

export function thoughtFor(kind: Goal["kind"], rand: () => number = Math.random): string {
  return THOUGHTS[kind][Math.floor(rand() * THOUGHTS[kind].length)];
}

// --- fun stats: Sims-style meters + lifetime counters, persisted ---------

export interface HorseStats {
  fun: number; // 0..1, treats and snacks top it up
  social: number; // 0..1, rises near other horses
  treats: number; // hard-feed snacks eaten
  drinks: number; // trips to the water bowl
  naps: number; // rests finished
  distance: number; // world px wandered
}

export function newStats(): HorseStats {
  return { fun: 0.6, social: 0.6, treats: 0, drinks: 0, naps: 0, distance: 0 };
}

export function tickStats(s: HorseStats, dtMin: number, nearOthers: boolean): HorseStats {
  const drift = (v: number, r: number) => Math.min(1, Math.max(0, v + r * dtMin));
  return {
    ...s,
    fun: drift(s.fun, -0.004),
    social: drift(s.social, nearOthers ? 0.03 : -0.01),
  };
}

// Apply the payoff when a horse finishes an action.
export function savourStats(s: HorseStats, kind: Goal["kind"]): HorseStats {
  switch (kind) {
    case "feed":
      return { ...s, treats: s.treats + 1, fun: Math.min(1, s.fun + 0.35) };
    case "hay":
      return { ...s, fun: Math.min(1, s.fun + 0.2) };
    case "graze":
      return { ...s, fun: Math.min(1, s.fun + 0.1) };
    case "water":
      return { ...s, drinks: s.drinks + 1 };
    case "rest":
      return { ...s, naps: s.naps + 1 };
    default:
      return s;
  }
}

// --- persistence: versioned, validated, safe to feed anything -------------

export interface SavedHorse {
  needs: Needs;
  x: number;
  y: number;
  stats: HorseStats;
}

export interface SaveData {
  v: 1;
  dayT: number;
  horses: Record<string, SavedHorse>;
}

export const SAVE_VERSION = 1;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function decodeNeeds(v: unknown): Needs | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!finite(o["hunger"]) || !finite(o["thirst"]) || !finite(o["energy"]) || !finite(o["boredom"]))
    return null;
  return {
    hunger: clamp01(o["hunger"] as number),
    thirst: clamp01(o["thirst"] as number),
    energy: clamp01(o["energy"] as number),
    boredom: clamp01(o["boredom"] as number),
  };
}

function decodeStats(v: unknown): HorseStats | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    !finite(o["fun"]) ||
    !finite(o["social"]) ||
    !finite(o["treats"]) ||
    !finite(o["drinks"]) ||
    !finite(o["naps"]) ||
    !finite(o["distance"])
  )
    return null;
  return {
    fun: clamp01(o["fun"] as number),
    social: clamp01(o["social"] as number),
    treats: Math.max(0, Math.floor(o["treats"] as number)),
    drinks: Math.max(0, Math.floor(o["drinks"] as number)),
    naps: Math.max(0, Math.floor(o["naps"] as number)),
    distance: Math.max(0, o["distance"] as number),
  };
}

export function encodeSave(
  dayT: number,
  horses: Array<{ name: string; x: number; y: number; needs: Needs; stats: HorseStats }>,
): string {
  const out: Record<string, SavedHorse> = {};
  for (const h of horses) out[h.name] = { needs: h.needs, x: h.x, y: h.y, stats: h.stats };
  const data: SaveData = { v: SAVE_VERSION, dayT, horses: out };
  return JSON.stringify(data);
}

// Never throws: garbage in, null out. Out-of-range numbers are clamped.
export function decodeSave(json: string): SaveData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o["v"] !== SAVE_VERSION || !finite(o["dayT"])) return null;
  if (typeof o["horses"] !== "object" || o["horses"] === null) return null;
  const horses: Record<string, SavedHorse> = {};
  for (const [name, entry] of Object.entries(o["horses"] as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    const needs = decodeNeeds(e["needs"]);
    const stats = decodeStats(e["stats"]);
    if (!needs || !stats || !finite(e["x"]) || !finite(e["y"])) return null;
    horses[name] = { needs, x: e["x"] as number, y: e["y"] as number, stats };
  }
  return { v: 1, dayT: (((o["dayT"] as number) % 1) + 1) % 1, horses };
}
