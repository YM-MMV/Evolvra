import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricHistoryChart } from "@/components/metric-history-chart";
import type { MetricEntry, ProgressMetric } from "@/lib/types";

const metric: ProgressMetric = {
  id: "metric-one",
  label: "Distance",
  current: 8,
  target: 20,
  unit: "mi",
  weight: 100,
};

function entry(
  id: string,
  value: number,
  unit: string | undefined,
  recordedAt: string,
): MetricEntry {
  return {
    id,
    goalId: "goal-one",
    metricId: metric.id,
    label: metric.label,
    ...(unit ? { unit } : {}),
    value,
    previousValue: 0,
    recordedAt,
    source: "manual",
  };
}

describe("MetricHistoryChart", () => {
  it("uses the immutable entry unit instead of relabelling history with the current unit", () => {
    const html = renderToStaticMarkup(
      <MetricHistoryChart
        metric={metric}
        entries={[
          entry("entry-one", 5, "km", "2026-06-01T10:00:00.000Z"),
          entry("entry-two", 10, "km", "2026-06-08T10:00:00.000Z"),
        ]}
      />,
    );

    expect(html).toContain("5 km");
    expect(html).toContain("10 km");
    expect(html).not.toContain("5 mi");
    expect(html).toContain("<polyline");
  });

  it("does not draw a false continuous trend across different recorded units", () => {
    const html = renderToStaticMarkup(
      <MetricHistoryChart
        metric={metric}
        entries={[
          entry("entry-one", 10, "km", "2026-06-01T10:00:00.000Z"),
          entry("entry-two", 6, "mi", "2026-06-08T10:00:00.000Z"),
        ]}
      />,
    );

    expect(html).toContain("Recorded units changed");
    expect(html).toContain("10 km");
    expect(html).toContain("6 mi");
    expect(html).not.toContain("<polyline");
  });
});
