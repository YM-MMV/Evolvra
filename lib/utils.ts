import type { AppState, Goal, Quest } from "@/lib/types";

export const uid = (prefix = "id") =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));

export function goalProgress(goal: Goal): number | null {
  if (goal.model === "weighted") {
    return clamp(goal.milestones.reduce((total, milestone) => total + (milestone.completed ? milestone.weight : 0), 0));
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
    const metric = goal.metrics[0];
    return clamp(metric.target ? (metric.current / metric.target) * 100 : 0);
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

export function nextRepeatDate(repeat: Quest["repeat"], from?: string, today = new Date()) {
  const parsed = parseLocalDate(from);
  const date = parsed ? new Date(parsed) : new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (repeat === "daily") date.setDate(date.getDate() + 1);
  if (repeat === "weekly") date.setDate(date.getDate() + 7);
  if (repeat === "monthly") {
    const day = date.getDate();
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

export const getArea = (state: AppState, areaId?: string) => state.areas.find((area) => area.id === areaId);

export const escapeCsv = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;

export function downloadFile(name: string, content: string, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
