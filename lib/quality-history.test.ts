import { describe, expect, it } from "vitest";
import { buildQualityActivitySeries } from "@/lib/quality-history";

describe("quality activity history", () => {
  it("builds stable local-calendar buckets without double counting a quality", () => {
    const rows = buildQualityActivitySeries([
      { at: "2026-03-01T12:00:00", statIds: ["health", "health", "focus"] },
      { at: "2026-03-05T23:59:59", statIds: ["health"] },
      { at: "2026-03-06T00:00:00", statIds: ["focus"] },
      { at: "not-a-date", statIds: ["health"] },
      { at: "2026-03-02T12:00:00", statIds: ["archived"] },
    ], ["health", "focus"], new Date(2026, 2, 1), 30);

    expect(rows).toHaveLength(6);
    expect(rows[0].counts).toEqual({ health: 2, focus: 1 });
    expect(rows[1].counts).toEqual({ health: 0, focus: 1 });
    expect(rows.flatMap((row) => Object.keys(row.counts))).not.toContain("archived");
  });

  it("uses calendar boundaries across daylight-saving changes", () => {
    const rows = buildQualityActivitySeries([
      { at: "2026-03-29T00:30:00", statIds: ["rest"] },
      { at: "2026-03-30T00:30:00", statIds: ["rest"] },
    ], ["rest"], new Date(2026, 2, 1), 30);

    expect(rows.reduce((total, row) => total + row.counts.rest, 0)).toBe(2);
    expect(rows.every((row) => row.from.getHours() === 0 && row.to.getHours() === 0)).toBe(true);
    expect(rows.at(-1)?.to).toEqual(new Date(2026, 2, 31));
  });
});
