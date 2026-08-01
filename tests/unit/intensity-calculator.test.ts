import { describe, expect, it } from "vitest";
import { computeActivation, computeRetention, strengthTierOf } from "../../src/runtime/memory/intensity-calculator.js";

const thresholds = { mediumUp: 45, mediumDown: 35, permanentUp: 85 };
const now = new Date("2026-08-01T12:00:00.000Z");

describe("intensity calculator", () => {
  it("caps independent activation dates", () => {
    const dates = [
      "2026-07-18T10:00:00Z", "2026-07-19T10:00:00Z", "2026-07-20T10:00:00Z",
      "2026-07-21T10:00:00Z", "2026-07-22T10:00:00Z", "2026-07-23T10:00:00Z",
      "2026-07-24T10:00:00Z", "2026-07-25T10:00:00Z", "2026-07-26T10:00:00Z",
      "2026-07-27T10:00:00Z", "2026-07-28T10:00:00Z", "2026-07-29T10:00:00Z",
      "2026-07-30T10:00:00Z", "2026-07-31T10:00:00Z", "2026-08-01T10:00:00Z",
    ];
    expect(computeActivation({ hitDates: dates, now })).toBe(100);
  });
  it("applies recency decay with a 30% floor", () => {
    expect(computeActivation({ hitDates: ["2026-06-02T10:00:00Z"], now })).toBe(2);
    expect(computeActivation({ hitDates: ["2026-07-31T10:00:00Z"], now })).toBe(7);
  });
  it("applies retention hysteresis and user intent", () => {
    const base = { signals: { independentSessions: 0, independentDates: 0, conflicts: 0, ageDays: 0 }, thresholds };
    expect(computeRetention({ ...base, current: 39, signals: { ...base.signals, conflicts: 2 } }).movement).toBe("down");
    expect(computeRetention({ ...base, current: 44, signals: { ...base.signals, independentSessions: 1 } }).tier).toBe("medium");
    expect(computeRetention({ ...base, current: 84, signals: { ...base.signals, independentSessions: 1 } }).tier).toBe("permanent");
    expect(computeRetention({ ...base, current: 90, signals: { ...base.signals, conflicts: 10 } }).proposed).toBe(90);
    expect(computeRetention({ ...base, current: 20, signals: { ...base.signals, userIntent: true } }).proposed).toBe(70);
  });
  it("maps strength tier boundaries", () => {
    expect(strengthTierOf(44, thresholds)).toBe("short");
    expect(strengthTierOf(45, thresholds)).toBe("medium");
    expect(strengthTierOf(84, thresholds)).toBe("medium");
    expect(strengthTierOf(85, thresholds)).toBe("permanent");
  });
});
