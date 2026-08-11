import { describe, expect, it } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import {
  parseImportedState,
  WorkspaceImportError,
} from "@/lib/state-schema";
import { localDateKey, nextRepeatDate, parseLocalDate, uid } from "@/lib/utils";

function pseudoRandom(seed = 0x5eedc0de) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function randomJson(
  random: () => number,
  depth = 0,
): unknown {
  const choices = depth >= 5 ? 5 : 8;
  switch (Math.floor(random() * choices)) {
    case 0:
      return null;
    case 1:
      return random() < 0.5;
    case 2:
      return Math.floor((random() - 0.5) * 1_000_000);
    case 3:
      return `fuzz-${Math.floor(random() * 1_000_000).toString(36)}`;
    case 4:
      return random() < 0.5 ? Number.NaN : Number.POSITIVE_INFINITY;
    case 5:
      return Array.from(
        { length: Math.floor(random() * 5) },
        () => randomJson(random, depth + 1),
      );
    case 6:
    default:
      return Object.fromEntries(Array.from(
        { length: Math.floor(random() * 5) },
        (_, index) => [`key-${index}`, randomJson(random, depth + 1)],
      ));
  }
}

describe("bounded state-import properties", () => {
  it("either rejects deterministic malformed JSON with the typed boundary or returns a stable v3 state", () => {
    const random = pseudoRandom();
    for (let index = 0; index < 500; index += 1) {
      const candidate = index % 7 === 0
        ? {
            ...structuredClone(EMPTY_STATE),
            updatedAt: new Date(
              Date.UTC(2026, 0, 1) + index * 60_000,
            ).toISOString(),
          }
        : randomJson(random);
      try {
        const parsed = parseImportedState(candidate, "2026-07-29T12:00:00.000Z");
        expect(parsed.version).toBe(3);
        expect(parseImportedState(
          JSON.parse(JSON.stringify(parsed)) as unknown,
          "2026-07-29T12:00:00.000Z",
        )).toEqual(parsed);
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceImportError);
      }
    }
  });
});

describe("monthly recurrence properties", () => {
  it("preserves every anchor across short months and always returns a real next-month date", () => {
    for (let year = 2024; year <= 2032; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const lastDay = new Date(year, month + 1, 0).getDate();
        for (let anchor = 1; anchor <= 31; anchor += 1) {
          const dueDay = Math.min(anchor, lastDay);
          const due = new Date(year, month, dueDay);
          const nextKey = nextRepeatDate(
            "monthly",
            localDateKey(due),
            new Date(year, month, Math.max(1, dueDay - 1)),
            anchor,
          );
          const next = parseLocalDate(nextKey);
          expect(next).not.toBeNull();
          const expectedMonth = (month + 1) % 12;
          const expectedYear = month === 11 ? year + 1 : year;
          const expectedLastDay = new Date(expectedYear, expectedMonth + 1, 0).getDate();
          expect(next?.getFullYear()).toBe(expectedYear);
          expect(next?.getMonth()).toBe(expectedMonth);
          expect(next?.getDate()).toBe(Math.min(anchor, expectedLastDay));
        }
      }
    }
  });
});

describe("identifier generation properties", () => {
  it("produces unique UUID-compatible identifiers across a large sample", () => {
    const identifiers = Array.from({ length: 2_000 }, () => uid());
    expect(new Set(identifiers)).toHaveLength(identifiers.length);
    for (const identifier of identifiers) {
      expect(identifier).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    }
  });
});
