import type { ConsistencyPeriod, Goal, GoalModel, ProgressMetric } from "@/lib/types";
import { activePeriodKey, isPeriodKey } from "@/lib/utils";

const CONSISTENCY_PERIODS: readonly ConsistencyPeriod[] = [
  "week",
  "month",
  "quarter",
  "year",
];

export function hasPositiveWeightedMetric(metrics: readonly ProgressMetric[]) {
  return metrics.some((metric) => (
    typeof metric.weight === "number"
    && Number.isFinite(metric.weight)
    && metric.weight > 0
  ));
}

export function hasConsistencyPeriodMetadata(metric: ProgressMetric) {
  return Boolean(
    metric.period
    && CONSISTENCY_PERIODS.includes(metric.period)
    && metric.periodKey
    && isPeriodKey(metric.period, metric.periodKey),
  );
}

/**
 * Returns the user-facing reason a measured progress model is not safe to save.
 * Runtime commands use the same rule as the state schema and editing UI.
 */
export function goalProgressConfigurationIssue(
  goal: Pick<Goal, "model" | "metrics">,
  goalLabel = "goal",
): string | null {
  if (goal.model !== "numeric" && goal.model !== "consistency") return null;
  if (!Array.isArray(goal.metrics) || !goal.metrics.length) {
    return `A numeric or consistency ${goalLabel} needs at least one metric.`;
  }
  if (!hasPositiveWeightedMetric(goal.metrics)) {
    return `A numeric or consistency ${goalLabel} needs at least one metric with a positive relative weight.`;
  }
  if (
    goal.model === "consistency"
    && goal.metrics.some((metric) => !hasConsistencyPeriodMetadata(metric))
  ) {
    return "Every consistency metric needs a valid period and matching period key.";
  }
  return null;
}

/**
 * Adapts measurement metadata when a goal changes progress model. Existing
 * consistency counters roll to zero if their recorded period has elapsed;
 * an explicit numeric-to-consistency conversion keeps its current value as the
 * starting value for the newly selected period.
 */
export function metricsForGoalModel(
  metrics: readonly ProgressMetric[],
  model: GoalModel,
  now = new Date(),
): ProgressMetric[] {
  return metrics.map((metric) => {
    if (model === "consistency") {
      const period = metric.period ?? "month";
      const periodKey = activePeriodKey(period, now);
      return {
        ...metric,
        current: metric.periodKey && metric.periodKey !== periodKey ? 0 : metric.current,
        period,
        periodKey,
      };
    }
    const { period: _period, periodKey: _periodKey, ...unscopedMetric } = metric;
    void _period;
    void _periodKey;
    return unscopedMetric;
  });
}

export function assertGoalProgressConfiguration(
  goal: Pick<Goal, "model" | "metrics">,
) {
  const issue = goalProgressConfigurationIssue(goal);
  if (issue) throw new Error(issue);
}
