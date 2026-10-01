import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Station } from "../src/sim.ts";
import {
  decideGoal,
  decodeSave,
  encodeSave,
  formatClock,
  newStats,
  phaseOf,
  savourStats,
  skyAt,
  thoughtFor,
  tickNeeds,
  tickStats,
} from "../src/sim.ts";

const stations: Station[] = [
  { id: "g1", kind: "graze", x: 0, y: 0 },
  { id: "hay", kind: "hay", x: 100, y: 0 },
  { id: "feed", kind: "feed", x: 200, y: 0 },
  { id: "water", kind: "water", x: 300, y: 0 },
];

describe("phaseOf", () => {
  // dayT 0 = 06:00, so 0.01 = 14.4 min. These are the clock times a visitor
  // would expect each phase to appear at.
  const at = (hour: number) => ((((hour - 6) / 24) % 1) + 1) % 1;

  it("names each part of the day at the expected clock time", () => {
    assert.equal(phaseOf(at(6)), "sunrise");
    assert.equal(phaseOf(at(8)), "morning");
    assert.equal(phaseOf(at(13)), "midday");
    assert.equal(phaseOf(at(17)), "evening");
    assert.equal(phaseOf(at(18)), "sunset");
    assert.equal(phaseOf(at(19)), "twilight");
    assert.equal(phaseOf(at(21)), "night");
  });
});

describe("skyAt", () => {
  const at = (hour: number) => ((((hour - 6) / 24) % 1) + 1) % 1;

  it("is bright at midday and dark in the small hours", () => {
    assert.equal(skyAt(at(13)).ambient, 0);
    assert.ok(skyAt(at(1)).ambient > 0.65);
  });

  it("ramps smoothly rather than jumping", () => {
    // A day is 300s, so one 0.01 step is 3s of real time. The steepest ramp
    // is dawn (0.38 -> 0.08 over ~42 in-game minutes), which is ~7% per
    // 3s tick — a fade, not a cut. Nothing may exceed that by much.
    let prev = skyAt(0.0).ambient;
    for (let t = 0.01; t < 1; t += 0.01) {
      const a = skyAt(t).ambient;
      assert.ok(Math.abs(a - prev) < 0.08, `jump at ${t.toFixed(2)}: ${prev} -> ${a}`);
      assert.ok(a >= 0 && a <= 1);
      prev = a;
    }
  });

  it("wraps continuously from midnight back to sunrise", () => {
    const end = skyAt(0.999);
    const start = skyAt(0.001);
    assert.ok(Math.abs(end.ambient - start.ambient) < 0.02);
  });

  it("tints warm at sunrise and sunset, cool blue in the small hours", () => {
    const rgb = (t: number) => {
      const c = skyAt(t).tint;
      return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
    };
    const [r6, g6, b6] = rgb(at(6));
    assert.ok(r6 > 240 && r6 > b6 + 60, "sunrise is warm");
    const [r18, , b18] = rgb(at(18));
    assert.ok(r18 > 240 && r18 > b18 + 60, "sunset is warm");
    const [r1, g1, b1] = rgb(at(1));
    assert.ok(b1 > r1, "night leans blue");
    assert.ok(b1 > g1, "night leans blue");
  });
});

describe("tickNeeds", () => {
  it("hunger and thirst rise over time", () => {
    const n = { hunger: 0, thirst: 0, energy: 1, boredom: 0 };
    const next = tickNeeds(n, 60, "midday");
    assert.ok(next.hunger > 0 && next.thirst > 0);
    assert.ok(next.hunger <= 1 && next.thirst <= 1);
  });

  it("energy recovers at night", () => {
    const n = { hunger: 0, thirst: 0, energy: 0.1, boredom: 0 };
    const next = tickNeeds(n, 60, "night");
    assert.ok(next.energy > n.energy);
  });
});

describe("decideGoal", () => {
  it("sends thirsty horses to water", () => {
    const g = decideGoal(
      { hunger: 0.1, thirst: 0.9, energy: 1, boredom: 0 },
      "midday",
      stations,
      0,
      0,
      () => 0.5,
    );
    assert.equal(g.kind, "water");
    assert.equal(g.stationId, "water");
  });

  it("rests tired horses at night", () => {
    const g = decideGoal(
      { hunger: 0.1, thirst: 0.1, energy: 0.2, boredom: 0 },
      "night",
      stations,
      10,
      20,
      () => 0.5,
    );
    assert.equal(g.kind, "rest");
  });

  it("sends hungry horses toward food", () => {
    const g = decideGoal(
      { hunger: 0.9, thirst: 0.1, energy: 1, boredom: 0 },
      "morning",
      stations,
      0,
      0,
      () => 0.0,
    );
    assert.ok(g.kind === "feed" || g.kind === "hay" || g.kind === "graze");
  });
});

describe("thoughtFor", () => {
  it("returns a non-empty line for every goal", () => {
    for (const k of ["wander", "graze", "hay", "feed", "water", "rest"] as const) {
      assert.ok(thoughtFor(k, () => 0).length > 0);
    }
  });
});

describe("formatClock", () => {
  it("maps the day cycle onto 06:00-06:00 wall time", () => {
    assert.equal(formatClock(0), "06:00");
    assert.equal(formatClock(0.25), "12:00");
    assert.equal(formatClock(0.5), "18:00");
    assert.equal(formatClock(0.75), "00:00");
    assert.equal(formatClock(0.08), "07:55");
  });
});

describe("horse stats", () => {
  it("social rises near others and falls alone, clamped", () => {
    const s = newStats();
    const near = tickStats(s, 60, true);
    assert.ok(near.social > s.social && near.social <= 1);
    const alone = tickStats(s, 600, false);
    assert.ok(alone.social < s.social && alone.social >= 0);
  });

  it("fun drifts down over time", () => {
    const next = tickStats(newStats(), 600, true);
    assert.ok(next.fun < 0.6 && next.fun >= 0);
  });

  it("savouring pays off per action", () => {
    const s = newStats();
    const fed = savourStats(s, "feed");
    assert.equal(fed.treats, 1);
    assert.ok(fed.fun > s.fun);
    assert.equal(savourStats(s, "water").drinks, 1);
    assert.equal(savourStats(s, "rest").naps, 1);
    assert.deepEqual(savourStats(s, "wander"), s);
  });
});

describe("save codec", () => {
  const horses = [
    {
      name: "Trev",
      x: 1,
      y: 2,
      needs: { hunger: 0.5, thirst: 0.5, energy: 0.5, boredom: 0.5 },
      stats: newStats(),
    },
  ];

  it("round-trips", () => {
    const back = decodeSave(encodeSave(0.08, horses));
    assert.ok(back);
    assert.equal(back.v, 1);
    assert.equal(back.horses["Trev"].x, 1);
    assert.equal(back.horses["Trev"].needs.hunger, 0.5);
  });

  it("rejects garbage, wrong versions and bad shapes", () => {
    assert.equal(decodeSave("nope{"), null);
    assert.equal(decodeSave("[1,2]"), null);
    assert.equal(decodeSave(JSON.stringify({ v: 2, dayT: 0, horses: {} })), null);
    assert.equal(decodeSave(JSON.stringify({ v: 1, dayT: 0 })), null);
    assert.equal(decodeSave(JSON.stringify({ v: 1, dayT: 0, horses: { Trev: { x: 1 } } })), null);
  });

  it("clamps out-of-range numbers instead of rejecting", () => {
    const data = {
      v: 1,
      dayT: 0.5,
      horses: {
        Trev: {
          x: 1,
          y: 2,
          needs: { hunger: 9, thirst: -3, energy: 0.5, boredom: 0.5 },
          stats: { fun: 2, social: -1, treats: 2.7, drinks: 0, naps: 0, distance: -5 },
        },
      },
    };
    const back = decodeSave(JSON.stringify(data));
    assert.ok(back);
    assert.equal(back.horses["Trev"].needs.hunger, 1);
    assert.equal(back.horses["Trev"].needs.thirst, 0);
    assert.equal(back.horses["Trev"].stats.fun, 1);
    assert.equal(back.horses["Trev"].stats.treats, 2);
    assert.equal(back.horses["Trev"].stats.distance, 0);
  });
});
