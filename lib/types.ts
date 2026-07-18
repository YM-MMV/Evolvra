export type GoalStatus = "active" | "paused" | "completed" | "archived";
export type GoalModel = "numeric" | "weighted" | "consistency" | "open";
export type Priority = "low" | "medium" | "high" | "critical";
export type ReviewCadence = "daily" | "weekly" | "monthly";

export interface Area {
  id: string;
  name: string;
  color: string;
  icon: string;
  order: number;
  hidden?: boolean;
  archived?: boolean;
}

export interface LifeStat {
  id: string;
  name: string;
  color: string;
  icon: string;
  archived?: boolean;
}

export interface ProgressMetric {
  id: string;
  label: string;
  current: number;
  target: number;
  unit: string;
  weight: number;
}

export interface MetricDelta {
  metricId: string;
  amount: number;
}

export interface Milestone {
  id: string;
  title: string;
  weight: number;
  completed: boolean;
  completedAt?: string;
}

export interface Quest {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  repeat: "none" | "daily" | "weekly" | "monthly";
  completed: boolean;
  completedAt?: string;
  durationMinutes?: number;
  metricDeltas: MetricDelta[];
}

export interface GoalCheckIn {
  id: string;
  createdAt: string;
  note: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  areaId: string;
  model: GoalModel;
  priority: Priority;
  targetDate?: string;
  status: GoalStatus;
  createdAt: string;
  completedAt?: string;
  metrics: ProgressMetric[];
  milestones: Milestone[];
  quests: Quest[];
  statIds: string[];
  checkIns: GoalCheckIn[];
  evidence: string[];
  notes: string;
}

export interface QuestCompletion {
  id: string;
  goalId: string;
  questId: string;
  title: string;
  completedAt: string;
  durationMinutes?: number;
}

export interface MetricEntry {
  id: string;
  goalId: string;
  metricId: string;
  value: number;
  previousValue: number;
  recordedAt: string;
  source: "manual" | "quest";
}

export interface Review {
  id: string;
  cadence: ReviewCadence;
  createdAt: string;
  answers: Record<string, string>;
}

export interface TimelineEvent {
  id: string;
  type: "quest" | "milestone" | "goal" | "review" | "note" | "metric";
  title: string;
  detail: string;
  at: string;
  goalId?: string;
  areaId?: string;
}

export interface Terminology {
  goals: string;
  quests: string;
  areas: string;
  milestones: string;
  stats: string;
}

export interface UserSettings {
  theme: "dark" | "light" | "system";
  gameIntensity: "minimal" | "balanced" | "immersive";
  birthDate?: string;
  notifications: boolean;
  terminology: Terminology;
}

export interface Profile {
  displayName: string;
  chapter: string;
  onboarded: boolean;
  createdAt: string;
}

export interface AppState {
  version: 2;
  updatedAt: string;
  profile: Profile;
  settings: UserSettings;
  areas: Area[];
  stats: LifeStat[];
  goals: Goal[];
  questCompletions: QuestCompletion[];
  metricEntries: MetricEntry[];
  reviews: Review[];
  timeline: TimelineEvent[];
}
