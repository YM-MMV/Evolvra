import type { AppState, Area, Goal, LifeStat, UserSettings } from "@/lib/types";
import { DASHBOARD_SECTION_IDS } from "@/lib/types";
import { activePeriodKey, localDateKey } from "@/lib/utils";

const now = new Date().toISOString();

/** Stable, database-compatible identifiers for the built-in starter workspace. */
const STARTER_IDS = {
  areas: {
    university: "10000000-0000-4000-8000-000000000001",
    career: "10000000-0000-4000-8000-000000000002",
    projects: "10000000-0000-4000-8000-000000000003",
    health: "10000000-0000-4000-8000-000000000004",
    money: "10000000-0000-4000-8000-000000000005",
    personal: "10000000-0000-4000-8000-000000000006",
    social: "10000000-0000-4000-8000-000000000007",
  },
  stats: {
    knowledge: "20000000-0000-4000-8000-000000000001",
    health: "20000000-0000-4000-8000-000000000002",
    discipline: "20000000-0000-4000-8000-000000000003",
    communication: "20000000-0000-4000-8000-000000000004",
    creativity: "20000000-0000-4000-8000-000000000005",
    finance: "20000000-0000-4000-8000-000000000006",
    social: "20000000-0000-4000-8000-000000000007",
    technical: "20000000-0000-4000-8000-000000000008",
  },
  goals: {
    evolvra: "30000000-0000-4000-8000-000000000001",
    fitness: "30000000-0000-4000-8000-000000000002",
    savings: "30000000-0000-4000-8000-000000000003",
  },
  metrics: {
    runs: "40000000-0000-4000-8000-000000000001",
    savings: "40000000-0000-4000-8000-000000000002",
  },
  milestones: {
    setup: "50000000-0000-4000-8000-000000000001",
    goals: "50000000-0000-4000-8000-000000000002",
    rhythm: "50000000-0000-4000-8000-000000000003",
    month: "50000000-0000-4000-8000-000000000004",
    fiveKm: "50000000-0000-4000-8000-000000000005",
    fitnessMonth: "50000000-0000-4000-8000-000000000006",
    oneThousand: "50000000-0000-4000-8000-000000000007",
    twoThousand: "50000000-0000-4000-8000-000000000008",
  },
  quests: {
    firstGoal: "60000000-0000-4000-8000-000000000001",
    checkIn: "60000000-0000-4000-8000-000000000002",
    run: "60000000-0000-4000-8000-000000000003",
    budget: "60000000-0000-4000-8000-000000000004",
  },
} as const;

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "dark",
  interfaceIntensity: "balanced",
  notifications: false,
  reminderTime: "18:00",
  dashboardOrder: [...DASHBOARD_SECTION_IDS],
  hiddenDashboardSections: [],
  terminology: {
    goals: "Goals",
    quests: "Quests",
    areas: "Areas",
    milestones: "Milestones",
    stats: "Stats",
  },
};

export const DEFAULT_AREAS: Area[] = [
  { id: STARTER_IDS.areas.university, name: "University", color: "#8B7CFF", icon: "GraduationCap", order: 0 },
  { id: STARTER_IDS.areas.career, name: "Career", color: "#48A9FF", icon: "BriefcaseBusiness", order: 1 },
  { id: STARTER_IDS.areas.projects, name: "Business & Projects", color: "#F59E5B", icon: "Rocket", order: 2 },
  { id: STARTER_IDS.areas.health, name: "Health", color: "#38D69B", icon: "HeartPulse", order: 3 },
  { id: STARTER_IDS.areas.money, name: "Money", color: "#EACB58", icon: "Landmark", order: 4 },
  { id: STARTER_IDS.areas.personal, name: "Personal Development", color: "#D97AF5", icon: "Sparkles", order: 5 },
  { id: STARTER_IDS.areas.social, name: "Social Life", color: "#FF7C9E", icon: "Users", order: 6 },
];

export const DEFAULT_STATS: LifeStat[] = [
  { id: STARTER_IDS.stats.knowledge, name: "Knowledge", color: "#8B7CFF", icon: "Brain" },
  { id: STARTER_IDS.stats.health, name: "Health", color: "#38D69B", icon: "HeartPulse" },
  { id: STARTER_IDS.stats.discipline, name: "Discipline", color: "#48A9FF", icon: "ShieldCheck" },
  { id: STARTER_IDS.stats.communication, name: "Communication", color: "#FF7C9E", icon: "MessagesSquare" },
  { id: STARTER_IDS.stats.creativity, name: "Creativity", color: "#D97AF5", icon: "Palette" },
  { id: STARTER_IDS.stats.finance, name: "Finance", color: "#EACB58", icon: "ChartNoAxesCombined" },
  { id: STARTER_IDS.stats.social, name: "Social", color: "#F59E5B", icon: "Users" },
  { id: STARTER_IDS.stats.technical, name: "Technical", color: "#4DD8E7", icon: "CodeXml" },
];

export function createStarterGoals(): Goal[] {
  const today = new Date();
  const inMonths = (months: number) => {
    const date = new Date(today);
    date.setMonth(date.getMonth() + months);
    return localDateKey(date);
  };

  return [
    {
      id: STARTER_IDS.goals.evolvra,
      title: "Build my personal command centre",
      description: "Create a reliable system for seeing what matters, choosing the next action, and recording genuine development.",
      areaId: STARTER_IDS.areas.projects,
      model: "weighted",
      priority: "high",
      targetDate: inMonths(2),
      status: "active",
      createdAt: now,
      metrics: [],
      milestones: [
        {
          id: STARTER_IDS.milestones.setup,
          title: "Set up my life areas and stats",
          weight: 25,
          completed: true,
          completedAt: now,
          attribution: {
            areaId: STARTER_IDS.areas.projects,
            statIds: [STARTER_IDS.stats.discipline, STARTER_IDS.stats.knowledge, STARTER_IDS.stats.technical],
          },
        },
        { id: STARTER_IDS.milestones.goals, title: "Define my first three meaningful goals", weight: 30, completed: false },
        { id: STARTER_IDS.milestones.rhythm, title: "Complete my first weekly review", weight: 20, completed: false },
        { id: STARTER_IDS.milestones.month, title: "Use Evolvra for one full month", weight: 25, completed: false },
      ],
      quests: [
        {
          id: STARTER_IDS.quests.firstGoal,
          kind: "task",
          linkedGoalIds: [],
          title: "Add one real goal",
          description: "Choose an outcome that matters and define how progress will be measured.",
          repeat: "none",
          completed: false,
          metricDeltas: [],
        },
        {
          id: STARTER_IDS.quests.checkIn,
          kind: "task",
          linkedGoalIds: [],
          title: "Write today’s check-in",
          repeat: "daily",
          completed: false,
          metricDeltas: [],
        },
      ],
      statIds: [STARTER_IDS.stats.discipline, STARTER_IDS.stats.knowledge, STARTER_IDS.stats.technical],
      checkIns: [],
      evidence: [],
      notes: "Keep the system honest, calm, and useful on difficult weeks.",
    },
    {
      id: STARTER_IDS.goals.fitness,
      title: "Build dependable cardiovascular fitness",
      description: "Develop a sustainable running habit that can adapt to real life and missed days.",
      areaId: STARTER_IDS.areas.health,
      model: "consistency",
      priority: "medium",
      targetDate: inMonths(4),
      status: "active",
      createdAt: now,
      metrics: [
        {
          id: STARTER_IDS.metrics.runs,
          label: "Sessions this month",
          current: 3,
          target: 12,
          unit: "runs",
          weight: 100,
          period: "month",
          periodKey: activePeriodKey("month", today),
        },
      ],
      milestones: [
        { id: STARTER_IDS.milestones.fiveKm, title: "Complete a comfortable 5 km", weight: 50, completed: false },
        { id: STARTER_IDS.milestones.fitnessMonth, title: "Complete 12 sessions in a month", weight: 50, completed: false },
      ],
      quests: [
        {
          id: STARTER_IDS.quests.run,
          kind: "session",
          linkedGoalIds: [],
          title: "Complete an easy 30-minute run",
          repeat: "weekly",
          completed: false,
          durationMinutes: 30,
          metricDeltas: [{ metricId: STARTER_IDS.metrics.runs, amount: 1 }],
        },
      ],
      statIds: [STARTER_IDS.stats.health, STARTER_IDS.stats.discipline],
      checkIns: [],
      evidence: [],
      notes: "Aim for consistency over intensity.",
    },
    {
      id: STARTER_IDS.goals.savings,
      title: "Build a £2,000 opportunity fund",
      description: "Create financial breathing room for courses, travel, or a new project.",
      areaId: STARTER_IDS.areas.money,
      model: "numeric",
      priority: "medium",
      targetDate: inMonths(6),
      status: "active",
      createdAt: now,
      metrics: [{ id: STARTER_IDS.metrics.savings, label: "Saved", current: 650, target: 2000, unit: "£", weight: 100 }],
      milestones: [
        { id: STARTER_IDS.milestones.oneThousand, title: "Reach £1,000", weight: 50, completed: false },
        { id: STARTER_IDS.milestones.twoThousand, title: "Reach £2,000", weight: 50, completed: false },
      ],
      quests: [
        {
          id: STARTER_IDS.quests.budget,
          kind: "task",
          linkedGoalIds: [],
          title: "Review this month’s spending",
          repeat: "monthly",
          completed: false,
          metricDeltas: [],
        },
      ],
      statIds: [STARTER_IDS.stats.finance, STARTER_IDS.stats.discipline],
      checkIns: [],
      evidence: [],
      notes: "Progress should come from real savings, not task completion.",
    },
  ];
}

export const EMPTY_STATE: AppState = {
  version: 3,
  updatedAt: now,
  profile: { displayName: "", chapter: "Building a life with direction", onboarded: false, createdAt: now },
  settings: DEFAULT_SETTINGS,
  areas: DEFAULT_AREAS,
  stats: DEFAULT_STATS,
  goals: [],
  questCompletions: [],
  metricEntries: [],
  reviews: [],
  timeline: [],
};
