import { MAX_WORKSPACE_SERIALIZED_BYTES } from "@/lib/state-schema";
import type { AppState } from "@/lib/types";
import { profileJsonValue } from "@/lib/workspace-json-profile";

const MEBIBYTE = 1024 * 1024;
const KIBIBYTE = 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Capacity guidance intentionally starts well before the hard persistence
 * boundary. A forecast can enter "watch" even earlier when recent activity
 * would reach the advisory point within the look-ahead window.
 */
export const WORKSPACE_CAPACITY_NOTICE_BYTES = 3 * MEBIBYTE;
export const WORKSPACE_CAPACITY_CRITICAL_BYTES = 4 * MEBIBYTE;
export const WORKSPACE_CAPACITY_FORECAST_DAYS = 90;
export const WORKSPACE_CAPACITY_CRITICAL_FORECAST_DAYS = 30;
export const WORKSPACE_CAPACITY_ACTIVITY_WINDOW_DAYS = 30;
export const WORKSPACE_CAPACITY_MIN_OBSERVATION_DAYS = 7;

export type WorkspaceCapacitySeverity = "healthy" | "watch" | "critical";

export interface WorkspaceCapacityForecast {
  serializedBytes: number;
  limitBytes: number;
  remainingBytes: number;
  utilisationRatio: number;
  severity: WorkspaceCapacitySeverity;
  recentActivityRecords: number;
  recentActivityBytes: number;
  averageActivityBytes: number | null;
  recentDailyGrowthBytes: number | null;
  estimatedAdditionalActivityRecords: number | null;
  estimatedDaysUntilNotice: number | null;
  estimatedDaysUntilLimit: number | null;
}

interface TimestampedActivity {
  at: string;
  value: unknown;
}

function* timestampedActivity(
  state: AppState,
): Generator<TimestampedActivity> {
  for (const value of state.questCompletions) {
    yield { at: value.completedAt, value };
  }
  for (const value of state.metricEntries) {
    yield { at: value.recordedAt, value };
  }
  for (const value of state.reviews) {
    yield { at: value.createdAt, value };
  }
  for (const value of state.timeline) {
    yield { at: value.at, value };
  }
  for (const goal of state.goals) {
    for (const value of goal.checkIns) {
      yield { at: value.createdAt, value };
    }
  }
}

function estimatedDaysUntil(
  targetBytes: number,
  currentBytes: number,
  dailyGrowthBytes: number | null,
) {
  if (currentBytes >= targetBytes) return 0;
  if (dailyGrowthBytes === null || dailyGrowthBytes <= 0) return null;
  return Math.ceil((targetBytes - currentBytes) / dailyGrowthBytes);
}

/**
 * Returns aggregate capacity numbers only. The report contains no workspace
 * strings, identifiers, dates, account paths, or evidence metadata and never
 * sends data off-device.
 */
export function forecastWorkspaceCapacity(
  state: AppState,
  now = new Date(),
): WorkspaceCapacityForecast {
  const serializedBytes = profileJsonValue(state).bytes;
  const nowMs = now.getTime();
  const windowStartMs = nowMs
    - WORKSPACE_CAPACITY_ACTIVITY_WINDOW_DAYS * DAY_MS;
  let recentActivityRecords = 0;
  let recentActivityBytes = 0;
  let oldestRecentMs = nowMs;
  for (const { at, value } of timestampedActivity(state)) {
    const atMs = Date.parse(at);
    if (!(
      Number.isFinite(atMs)
      && atMs <= nowMs
      && atMs >= windowStartMs
    )) continue;
    recentActivityRecords += 1;
    recentActivityBytes += profileJsonValue(value).bytes + 1;
    oldestRecentMs = Math.min(oldestRecentMs, atMs);
  }
  const observedDays = recentActivityRecords
    ? Math.min(
      WORKSPACE_CAPACITY_ACTIVITY_WINDOW_DAYS,
      Math.max(
        WORKSPACE_CAPACITY_MIN_OBSERVATION_DAYS,
        Math.ceil((nowMs - oldestRecentMs) / DAY_MS) + 1,
      ),
    )
    : 0;
  const recentDailyGrowthBytes = recentActivityBytes > 0 && observedDays > 0
    ? recentActivityBytes / observedDays
    : null;
  const averageActivityBytes = recentActivityRecords
    ? recentActivityBytes / recentActivityRecords
    : null;
  const remainingBytes = Math.max(
    0,
    MAX_WORKSPACE_SERIALIZED_BYTES - serializedBytes,
  );
  const estimatedDaysUntilNotice = estimatedDaysUntil(
    WORKSPACE_CAPACITY_NOTICE_BYTES,
    serializedBytes,
    recentDailyGrowthBytes,
  );
  const estimatedDaysUntilLimit = estimatedDaysUntil(
    MAX_WORKSPACE_SERIALIZED_BYTES,
    serializedBytes,
    recentDailyGrowthBytes,
  );
  const critical = (
    serializedBytes >= WORKSPACE_CAPACITY_CRITICAL_BYTES
    || (
      estimatedDaysUntilLimit !== null
      && estimatedDaysUntilLimit <= WORKSPACE_CAPACITY_CRITICAL_FORECAST_DAYS
    )
  );
  const watch = (
    serializedBytes >= WORKSPACE_CAPACITY_NOTICE_BYTES
    || (
      estimatedDaysUntilNotice !== null
      && estimatedDaysUntilNotice <= WORKSPACE_CAPACITY_FORECAST_DAYS
    )
  );

  return {
    serializedBytes,
    limitBytes: MAX_WORKSPACE_SERIALIZED_BYTES,
    remainingBytes,
    utilisationRatio: Math.min(
      1,
      serializedBytes / MAX_WORKSPACE_SERIALIZED_BYTES,
    ),
    severity: critical ? "critical" : watch ? "watch" : "healthy",
    recentActivityRecords,
    recentActivityBytes,
    averageActivityBytes,
    recentDailyGrowthBytes,
    estimatedAdditionalActivityRecords: averageActivityBytes
      ? Math.floor(remainingBytes / averageActivityBytes)
      : null,
    estimatedDaysUntilNotice,
    estimatedDaysUntilLimit,
  };
}

export function formatWorkspaceBytes(bytes: number) {
  if (bytes >= MEBIBYTE) {
    return `${(bytes / MEBIBYTE).toFixed(2)} MiB`;
  }
  if (bytes >= KIBIBYTE) {
    return `${Math.ceil(bytes / KIBIBYTE).toLocaleString("en-GB")} KiB`;
  }
  return `${Math.max(0, Math.ceil(bytes)).toLocaleString("en-GB")} bytes`;
}

export function workspaceCapacityForecastText(
  forecast: WorkspaceCapacityForecast,
) {
  if (forecast.estimatedDaysUntilLimit === null) {
    return "A time estimate will appear after recent activity has established a local growth rate.";
  }
  if (forecast.estimatedDaysUntilLimit > 365) {
    return "At the recent rate, the hard limit is more than a year away.";
  }
  const unit = forecast.estimatedDaysUntilLimit === 1 ? "day" : "days";
  return `At the recent rate, the hard limit may be reached in about ${forecast.estimatedDaysUntilLimit.toLocaleString("en-GB")} ${unit}.`;
}
