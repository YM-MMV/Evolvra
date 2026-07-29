import { completionGoalIds } from "@/lib/activity-attribution";
import type { QuestCompletion } from "@/lib/types";

const DAY_MS = 86_400_000;

export type ConsistencyMomentumDirection = "no-data" | "rising" | "steady" | "falling";

export interface ConsistencySummary {
  weeklyRate: number;
  monthlyRate: number;
  totalSessions: number;
  totalRecordedMinutes: number;
  longTermMomentum: {
    direction: ConsistencyMomentumDirection;
    change: number;
    currentSessions: number;
    previousSessions: number;
  };
}

const validCompletionTime = (completion: QuestCompletion) => {
  const timestamp = new Date(completion.completedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

/**
 * Derives a consistency goal's activity summary exclusively from immutable
 * completion records. Rolling windows end at `now`; the momentum comparison is
 * the trailing 30 days against the immediately preceding 30 days.
 */
export function selectConsistencySummary(
  completions: readonly QuestCompletion[],
  goalId: string,
  now = new Date(),
): ConsistencySummary {
  const nowTime = now.getTime();
  const eligible = Number.isFinite(nowTime)
    ? completions.flatMap((completion) => {
        if (!completionGoalIds(completion).includes(goalId)) return [];
        const timestamp = validCompletionTime(completion);
        return timestamp !== null && timestamp <= nowTime ? [{ completion, timestamp }] : [];
      })
    : [];
  const weeklyStart = nowTime - (7 * DAY_MS);
  const currentMonthStart = nowTime - (30 * DAY_MS);
  const previousMonthStart = nowTime - (60 * DAY_MS);
  const weeklyRate = eligible.filter(({ timestamp }) => timestamp >= weeklyStart).length;
  const monthlyRate = eligible.filter(({ timestamp }) => timestamp >= currentMonthStart).length;
  const previousSessions = eligible.filter(({ timestamp }) => (
    timestamp >= previousMonthStart && timestamp < currentMonthStart
  )).length;
  const change = monthlyRate - previousSessions;
  const direction: ConsistencyMomentumDirection = monthlyRate === 0 && previousSessions === 0
    ? "no-data"
    : change > 0
      ? "rising"
      : change < 0
        ? "falling"
        : "steady";

  return {
    weeklyRate,
    monthlyRate,
    totalSessions: eligible.length,
    totalRecordedMinutes: eligible.reduce((total, { completion }) => {
      const duration = completion.durationMinutes;
      return total + (
        typeof duration === "number" && Number.isFinite(duration) && duration > 0
          ? duration
          : 0
      );
    }, 0),
    longTermMomentum: {
      direction,
      change,
      currentSessions: monthlyRate,
      previousSessions,
    },
  };
}
