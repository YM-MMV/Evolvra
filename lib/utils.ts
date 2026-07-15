import type { AppState, Goal, Quest, ScoringSettings } from "@/lib/types";

export const uid = (prefix = "id") =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, value));

export function questXp(quest: Pick<Quest, "effort" | "difficulty" | "impact">, scoring: ScoringSettings) {
  return Math.min(
    scoring.questCap,
    scoring.effort[quest.effort] + scoring.difficulty[quest.difficulty] + scoring.impact[quest.impact],
  );
}

export function goalProgress(goal: Goal): number | null {
  if (goal.status === "completed") return 100;

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

  return goal.checkInScore ?? null;
}

export function levelFromXp(xp: number, base = 100, growth = 25) {
  let level = 1;
  let used = 0;
  let needed = base + level * growth;
  while (xp - used >= needed) {
    used += needed;
    level += 1;
    needed = base + level * growth;
  }
  return { level, current: xp - used, needed, percent: ((xp - used) / needed) * 100 };
}

export const formatDate = (date?: string) => {
  if (!date) return "No date";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(date));
};

export const shortDate = (date?: string) => {
  if (!date) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(date));
};

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
