import type { AppState, ConsistencyPeriod, Goal, ProgressMetric, Quest } from "@/lib/types";

/** New records use database-compatible UUIDs; the argument remains for source compatibility. */
export const uid = (_prefix = "id") => {
  void _prefix;
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

export const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));

export const MAX_WORKSPACE_NUMBER = Number.MAX_SAFE_INTEGER;

export const isFiniteWorkspaceNumber = (
  value: number,
  minimum = -MAX_WORKSPACE_NUMBER,
  maximum = MAX_WORKSPACE_NUMBER,
) => Number.isFinite(value) && value >= minimum && value <= maximum;

export function goalProgress(goal: Goal, today = new Date()): number | null {
  if (goal.model === "weighted") {
    if (!goal.milestones.length) return 0;
    const totalWeight = goal.milestones.reduce((total, milestone) => total + milestone.weight, 0);
    if (totalWeight > 0) {
      const completedWeight = goal.milestones.reduce(
        (total, milestone) => total + (milestone.completed ? milestone.weight : 0),
        0,
      );
      return clamp((completedWeight / totalWeight) * 100);
    }
    const completedCount = goal.milestones.filter((milestone) => milestone.completed).length;
    return clamp((completedCount / goal.milestones.length) * 100);
  }

  if (goal.model === "numeric") {
    if (!goal.metrics.length) return 0;
    const totalWeight = goal.metrics.reduce((sum, metric) => sum + metric.weight, 0) || 1;
    return clamp(
      goal.metrics.reduce(
        (sum, metric) => sum + clamp(metric.target ? (metric.current / metric.target) * 100 : 0) * metric.weight,
        0,
      ) / totalWeight,
    );
  }

  if (goal.model === "consistency") {
    if (!goal.metrics.length) return 0;
    const totalWeight = goal.metrics.reduce((sum, metric) => sum + metric.weight, 0) || 1;
    return clamp(goal.metrics.reduce((sum, metric) => {
      const current = metric.period && metric.periodKey !== activePeriodKey(metric.period, today) ? 0 : metric.current;
      return sum + clamp(metric.target ? (current / metric.target) * 100 : 0) * metric.weight;
    }, 0) / totalWeight);
  }

  return null;
}

export function parseLocalDate(value?: string): Date | null {
  if (!value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const parsed = new Date(year, month, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day) return null;
    return parsed;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const formatDate = (date?: string) => {
  const parsed = parseLocalDate(date);
  if (!parsed) return "No date";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(parsed);
};

export const shortDate = (date?: string) => {
  const parsed = parseLocalDate(date);
  if (!parsed) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(parsed);
};

export const localDateKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Calendar windows use local time. Weeks start on Monday and use that Monday's date. */
export function activePeriodKey(period: ConsistencyPeriod, date = new Date()) {
  const year = date.getFullYear();
  if (period === "year") return `year:${year}`;
  if (period === "quarter") return `quarter:${year}-Q${Math.floor(date.getMonth() / 3) + 1}`;
  if (period === "month") return `month:${year}-${String(date.getMonth() + 1).padStart(2, "0")}`;

  const monday = new Date(year, date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return `week:${localDateKey(monday)}`;
}

export function isPeriodKey(period: ConsistencyPeriod, key: string) {
  if (period === "year") return /^year:\d{4}$/.test(key);
  if (period === "quarter") return /^quarter:\d{4}-Q[1-4]$/.test(key);
  if (period === "month") return /^month:\d{4}-(0[1-9]|1[0-2])$/.test(key);
  const match = /^week:(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return false;
  const monday = parseLocalDate(`${match[1]}-${match[2]}-${match[3]}`);
  return Boolean(monday && monday.getDay() === 1);
}

/** Returns a new metric, resetting only when its calendar window is stale or uninitialised. */
export function rollMetricPeriod(metric: ProgressMetric, today = new Date()): ProgressMetric {
  if (!metric.period) return { ...metric };
  const periodKey = activePeriodKey(metric.period, today);
  if (metric.periodKey === periodKey) return { ...metric };
  return { ...metric, current: 0, periodKey };
}

export function monthlyAnchorDayForSchedule(
  repeat: Quest["repeat"],
  dueDate?: string,
  previous?: Pick<Quest, "repeat" | "dueDate" | "monthlyAnchorDay">,
) {
  if (repeat !== "monthly") return undefined;
  if (
    previous?.repeat === "monthly"
    && previous.dueDate === dueDate
    && Number.isInteger(previous.monthlyAnchorDay)
    && previous.monthlyAnchorDay! >= 1
    && previous.monthlyAnchorDay! <= 31
  ) {
    return previous.monthlyAnchorDay;
  }
  return parseLocalDate(dueDate)?.getDate();
}

export function nextRepeatDate(
  repeat: Quest["repeat"],
  from?: string,
  today = new Date(),
  monthlyAnchorDay?: number,
) {
  const parsed = parseLocalDate(from);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const date = parsed && parsed > todayStart ? new Date(parsed) : todayStart;

  if (repeat === "daily") date.setDate(date.getDate() + 1);
  if (repeat === "weekly") date.setDate(date.getDate() + 7);
  if (repeat === "monthly") {
    const day = Number.isInteger(monthlyAnchorDay)
      && monthlyAnchorDay! >= 1
      && monthlyAnchorDay! <= 31
      ? monthlyAnchorDay!
      : date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
  }

  return localDateKey(date);
}

export function isQuestAvailable(quest: Pick<Quest, "completed" | "repeat" | "dueDate">, today = new Date()) {
  if (quest.repeat === "none" && quest.completed) return false;
  return !quest.dueDate || quest.dueDate <= localDateKey(today);
}

/** Dashboard due lists exclude undated actions, which belong to the Anytime group. */
export function isQuestDue(quest: Pick<Quest, "completed" | "repeat" | "dueDate">, today = new Date()) {
  return Boolean(quest.dueDate && isQuestAvailable(quest, today));
}

export const getArea = (state: AppState, areaId?: string) => state.areas.find((area) => area.id === areaId);

export const escapeCsv = (value: string | number) => {
  const raw = String(value);
  const formulaSafe = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
};

/** Best-effort singular label for user-configurable plural navigation terms. */
export function singularizeTerm(value: string) {
  const term = value.trim();
  if (/[^aeiou]ies$/i.test(term)) return `${term.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes)$/i.test(term)) return term.slice(0, -2);
  if (/s$/i.test(term) && !/(ss|us)$/i.test(term)) return term.slice(0, -1);
  return term;
}

export function downloadFile(name: string, content: string, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
