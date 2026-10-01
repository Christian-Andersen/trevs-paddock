import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideGoal, formatClock, phaseOf, thoughtFor, tickNeeds } from "../src/sim.ts";
import type { Station } from "../src/sim.ts";

const stations: Station[] = [
  { id: "g1", kind: "graze", x: 0, y: 0 },
  { id: "hay", kind: "hay", x: 100, y: 0 },
  { id: "feed", kind: "feed", x: 200, y: 0 },
  { id: "water", kind: "water", x: 300, y: 0 },
];

describe("phaseOf", () => {
  it("splits the day into four phases", () => {
    assert.equal(phaseOf(0.0), "morning");
    assert.equal(phaseOf(0.3), "midday");
    assert.equal(phaseOf(0.6), "evening");
    assert.equal(phaseOf(0.9), "night");
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
