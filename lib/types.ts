export type GoalStatus = "active" | "paused" | "completed" | "archived";
export type GoalModel = "numeric" | "weighted" | "consistency" | "open";
export type Priority = "low" | "medium" | "high" | "critical";
export type QuestEffort = "quick" | "standard" | "focused" | "major";
export type QuestDifficulty = "easy" | "moderate" | "difficult";
export type QuestImpact = "supporting" | "meaningful" | "important";
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
  xp: number;
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
  xp: number;
  completed: boolean;
  completedAt?: string;
}

export interface Quest {
  id: string;
  title: string;
  description?: string;
  dueDate?: string;
  effort: QuestEffort;
  difficulty: QuestDifficulty;
  impact: QuestImpact;
  xp: number;
  repeat: "none" | "daily" | "weekly" | "monthly";
  completed: boolean;
  completedAt?: string;
  durationMinutes?: number;
  metricDeltas: MetricDelta[];
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
  statWeights: Record<string, number>;
  checkInScore?: number;
  evidence: string[];
  notes: string;
}

export interface Review {
  id: string;
  cadence: ReviewCadence;
  createdAt: string;
  answers: Record<string, string>;
}

export interface TimelineEvent {
  id: string;
  type: "quest" | "milestone" | "goal" | "level" | "review" | "note" | "metric";
  title: string;
  detail: string;
  at: string;
  goalId?: string;
  areaId?: string;
  xp?: number;
}

export interface Terminology {
  goals: string;
  quests: string;
  areas: string;
  milestones: string;
  stats: string;
}

export interface ScoringSettings {
  effort: Record<QuestEffort, number>;
  difficulty: Record<QuestDifficulty, number>;
  impact: Record<QuestImpact, number>;
  questCap: number;
  levelBase: number;
  levelGrowth: number;
}

export interface UserSettings {
  theme: "dark" | "light" | "system";
  gameIntensity: "minimal" | "balanced" | "immersive";
  birthDate?: string;
  notifications: boolean;
  terminology: Terminology;
  scoring: ScoringSettings;
}

export interface Profile {
  displayName: string;
  chapter: string;
  onboarded: boolean;
  createdAt: string;
}

export interface AppState {
  version: number;
  updatedAt: string;
  profile: Profile;
  settings: UserSettings;
  areas: Area[];
  stats: LifeStat[];
  goals: Goal[];
  reviews: Review[];
  timeline: TimelineEvent[];
  overallXp: number;
}
