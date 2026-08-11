import { timelineHref, type TimelineFilters } from "@/lib/timeline";
import type { Goal, MetricEntry } from "@/lib/types";

export interface ReviewMetricMovement {
  key: string;
  goalId: string;
  goalTitle: string;
  label: string;
  unit: string;
  from?: number;
  to: number;
  updates: number;
  startsAfterUnitChange: boolean;
  href: string;
}

const metricKey = (entry: MetricEntry) => `${entry.goalId}|${entry.metricId}`;
const recordedUnit = (entry: MetricEntry) => entry.unit ?? "";

export function buildReviewMetricMovements(
  periodEntries: MetricEntry[],
  allEntries: MetricEntry[],
  goals: Goal[],
  period: Pick<TimelineFilters, "from" | "to">,
): ReviewMetricMovement[] {
  const previousEntryById = new Map<string, MetricEntry>();
  const previousByMetric = new Map<string, MetricEntry>();

  [...allEntries]
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id))
    .forEach((entry) => {
      const key = metricKey(entry);
      const previous = previousByMetric.get(key);
      if (previous) previousEntryById.set(entry.id, previous);
      previousByMetric.set(key, entry);
    });

  const activeMovementByMetric = new Map<string, ReviewMetricMovement>();
  const movements: ReviewMetricMovement[] = [];

  [...periodEntries]
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id))
    .forEach((entry) => {
      const goal = goals.find((item) => item.id === entry.goalId);
      if (!goal) return;
      const metric = goal.metrics.find((item) => item.id === entry.metricId);
      const key = metricKey(entry);
      const unit = recordedUnit(entry);
      const label = entry.label || metric?.label || "Measurement";
      const previousEntry = previousEntryById.get(entry.id);
      const startsAfterUnitChange = Boolean(previousEntry && recordedUnit(previousEntry) !== unit);
      const active = activeMovementByMetric.get(key);

      if (active && active.unit === unit) {
        if (active.from === undefined) active.from = active.to;
        active.to = entry.value;
        active.updates += 1;
        active.label = label;
        active.href = timelineHref(
          { ...period, type: "metric", goalId: goal.id, query: label },
          `event-record-metric-${entry.id}`,
        );
        return;
      }

      const movement: ReviewMetricMovement = {
        key: `${key}|${entry.id}`,
        goalId: goal.id,
        goalTitle: goal.title,
        label,
        unit,
        ...(startsAfterUnitChange ? {} : { from: entry.previousValue }),
        to: entry.value,
        updates: 1,
        startsAfterUnitChange,
        href: timelineHref(
          { ...period, type: "metric", goalId: goal.id, query: label },
          `event-record-metric-${entry.id}`,
        ),
      };
      movements.push(movement);
      activeMovementByMetric.set(key, movement);
    });

  return movements.sort((left, right) => {
    const leftDistance = left.from === undefined ? 0 : Math.abs(left.to - left.from);
    const rightDistance = right.from === undefined ? 0 : Math.abs(right.to - right.from);
    return rightDistance - leftDistance || left.goalTitle.localeCompare(right.goalTitle) || left.key.localeCompare(right.key);
  });
}
