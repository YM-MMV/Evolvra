export type GoalStatus = "active" | "paused" | "completed" | "archived";
export type GoalModel = "numeric" | "weighted" | "consistency" | "open";
export type Priority = "low" | "medium" | "high" | "critical";
export type ReviewCadence = "daily" | "weekly" | "monthly";
export type ConsistencyPeriod = "week" | "month" | "quarter" | "year";
export type QuestKind = "task" | "session" | "challenge" | "milestone";
export type DashboardSectionId = "life-map" | "momentum" | "goals" | "qualities" | "review";

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
  period?: ConsistencyPeriod;
  periodKey?: string;
}

export interface MetricDelta {
  metricId: string;
  amount: number;
}

/** Immutable context used by historic analytics after a goal is reorganised. */
export interface AttributionSnapshot {
  areaId: string;
  statIds: string[];
}

export interface GoalAttributionSnapshot extends AttributionSnapshot {
  goalId: string;
}

export interface Milestone {
  id: string;
  title: string;
  weight: number;
  completed: boolean;
  completedAt?: string;
  attribution?: AttributionSnapshot;
}

export interface Quest {
  id: string;
  kind: QuestKind;
  /** Additional goals this action supports; the containing goal remains primary. */
  linkedGoalIds: string[];
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
  attribution?: AttributionSnapshot;
}

interface GoalEvidenceBase {
  /** Stable UUID used to coordinate metadata with account-scoped blob storage. */
  id: string;
}

export interface GoalNoteEvidence extends GoalEvidenceBase {
  type: "note";
  text: string;
}

export interface GoalLinkEvidence extends GoalEvidenceBase {
  type: "link";
  url: string;
}

export interface GoalFileEvidence extends GoalEvidenceBase {
  type: "file";
  name: string;
  mimeType: string;
  size: number;
  /** Private Storage object path. File bytes remain in Storage or IndexedDB. */
  remotePath?: string;
}

export type GoalEvidence = GoalNoteEvidence | GoalLinkEvidence | GoalFileEvidence;

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
  evidence: GoalEvidence[];
  notes: string;
}

export interface QuestCompletion {
  id: string;
  goalId: string;
  /** Immutable snapshot of the action's additional goal connections. */
  linkedGoalIds: string[];
  /** Goal, area, and quality links as they existed when the action happened. */
  goalSnapshots?: GoalAttributionSnapshot[];
  questId: string;
  title: string;
  completedAt: string;
  durationMinutes?: number;
  note?: string;
  evidence: string[];
  metricDeltas: MetricDelta[];
}

export interface QuestCompletionInput {
  durationMinutes?: number;
  note?: string;
  evidence?: string[];
  metricDeltas?: MetricDelta[];
}

export interface MetricEntry {
  id: string;
  goalId: string;
  metricId: string;
  label?: string;
  unit?: string;
  value: number;
  previousValue: number;
  recordedAt: string;
  source: "manual" | "quest";
  /** Explicit causal link; present for measurement changes created by an action. */
  sourceCompletionId?: string;
  periodKey?: string;
  /** Goal organisation as it existed when this measurement was recorded. */
  attribution?: AttributionSnapshot;
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
  /** Immutable organisation links captured when this structural event was written. */
  relatedGoalIds?: string[];
  relatedAreaIds?: string[];
  relatedStatIds?: string[];
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
  interfaceIntensity: "minimal" | "balanced" | "immersive";
  birthDate?: string;
  notifications: boolean;
  reminderTime?: string;
  dashboardOrder: DashboardSectionId[];
  hiddenDashboardSections: DashboardSectionId[];
  terminology: Terminology;
}

export interface Profile {
  displayName: string;
  chapter: string;
  onboarded: boolean;
  createdAt: string;
}

export interface AppState {
  version: 3;
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
