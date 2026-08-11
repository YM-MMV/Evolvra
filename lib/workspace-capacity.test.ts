import { describe, expect, it } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import { MAX_WORKSPACE_SERIALIZED_BYTES } from "@/lib/state-schema";
import {
  forecastWorkspaceCapacity,
  formatWorkspaceBytes,
  WORKSPACE_CAPACITY_CRITICAL_BYTES,
  WORKSPACE_CAPACITY_NOTICE_BYTES,
  workspaceCapacityForecastText,
} from "@/lib/workspace-capacity";
import { profileJsonValue } from "@/lib/workspace-json-profile";
import type { AppState, TimelineEvent } from "@/lib/types";

const NOW = new Date("2026-07-29T12:00:00.000Z");

function timelineEvents(
  count: number,
  detailBytes: number,
  at = "2026-07-28T12:00:00.000Z",
): TimelineEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `capacity-event-${index}`,
    type: "note",
    title: "Capacity fixture",
    detail: "x".repeat(detailBytes),
    at,
  }));
}

function stateWithTimeline(timeline: TimelineEvent[]): AppState {
  return {
    ...structuredClone(EMPTY_STATE),
    updatedAt: NOW.toISOString(),
    timeline,
  };
}

describe("workspace capacity forecast", () => {
  it("reports the exact persistence size without exposing private content", () => {
    const privateDetail = "private reflection that must not leave the workspace";
    const state = stateWithTimeline([{
      ...timelineEvents(1, 10)[0],
      detail: privateDetail,
    }]);

    const report = forecastWorkspaceCapacity(state, NOW);

    expect(report.serializedBytes).toBe(profileJsonValue(state).bytes);
    expect(report.limitBytes).toBe(MAX_WORKSPACE_SERIALIZED_BYTES);
    expect(report.remainingBytes).toBe(
      MAX_WORKSPACE_SERIALIZED_BYTES - report.serializedBytes,
    );
    expect(JSON.stringify(report)).not.toContain(privateDetail);
    expect(Object.keys(report)).not.toContain("state");
  });

  it("warns before 60% when recent aggregate growth projects the advisory point within 90 days", () => {
    const state = stateWithTimeline(timelineEvents(80, 5_000));
    const report = forecastWorkspaceCapacity(state, NOW);

    expect(report.serializedBytes).toBeLessThan(
      WORKSPACE_CAPACITY_NOTICE_BYTES,
    );
    expect(report.estimatedDaysUntilNotice).not.toBeNull();
    expect(report.estimatedDaysUntilNotice!).toBeLessThanOrEqual(90);
    expect(report.severity).toBe("watch");
  });

  it("escalates at 4 MiB and estimates remaining activity records", () => {
    const state = stateWithTimeline(timelineEvents(850, 5_000));
    const report = forecastWorkspaceCapacity(state, NOW);

    expect(report.serializedBytes).toBeGreaterThanOrEqual(
      WORKSPACE_CAPACITY_CRITICAL_BYTES,
    );
    expect(report.serializedBytes).toBeLessThan(
      MAX_WORKSPACE_SERIALIZED_BYTES,
    );
    expect(report.severity).toBe("critical");
    expect(report.estimatedAdditionalActivityRecords).toBeGreaterThan(0);
  });

  it("ignores future and invalid activity dates rather than inventing a rate", () => {
    const state = stateWithTimeline([
      ...timelineEvents(1, 100, "not-a-date"),
      ...timelineEvents(1, 100, "2026-08-10T12:00:00.000Z"),
    ]);
    const report = forecastWorkspaceCapacity(state, NOW);

    expect(report.recentActivityRecords).toBe(0);
    expect(report.recentDailyGrowthBytes).toBeNull();
    expect(report.estimatedDaysUntilLimit).toBeNull();
    expect(workspaceCapacityForecastText(report)).toMatch(
      /time estimate will appear/i,
    );
  });

  it("formats binary byte units consistently", () => {
    expect(formatWorkspaceBytes(900)).toBe("900 bytes");
    expect(formatWorkspaceBytes(1_025)).toBe("2 KiB");
    expect(formatWorkspaceBytes(2.5 * 1024 * 1024)).toBe("2.50 MiB");
  });
});
