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

export type Phase = "morning" | "midday" | "evening" | "night";

export function phaseOf(dayT: number): Phase {
  // dayT in [0,1): 0 dawn, 0.5 dusk-ish. Keep it simple and legible.
  if (dayT < 0.25) return "morning";
  if (dayT < 0.5) return "midday";
  if (dayT < 0.75) return "evening";
  return "night";
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

export function tickNeeds(n: Needs, dtMin: number, phase: Phase): Needs {
  // dtMin: in-game minutes elapsed.
  const hungerRate = phase === "night" ? 0.004 : 0.012;
  const thirstRate = phase === "midday" ? 0.02 : 0.01;
  const boredomRate = 0.008;
  const drain = (v: number, r: number) => Math.min(1, Math.max(0, v + r * dtMin));
  const energy =
    phase === "night"
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

  // Night: rest where you stand unless very thirsty.
  if (phase === "night" && n.energy < 0.7 && n.thirst < 0.75) {
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

const THOUGHTS: Record<string, string[]> = {
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
  const list = THOUGHTS[kind] ?? THOUGHTS.wander;
  return list[Math.floor(rand() * list.length)];
}
