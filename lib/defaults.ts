import type { AppState, Area, Goal, LifeStat, UserSettings } from "@/lib/types";

const now = new Date().toISOString();

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "dark",
  gameIntensity: "balanced",
  notifications: false,
  terminology: {
    goals: "Goals",
    quests: "Quests",
    areas: "Areas",
    milestones: "Milestones",
    stats: "Stats",
  },
  scoring: {
    effort: { quick: 5, standard: 15, focused: 30, major: 50 },
    difficulty: { easy: 0, moderate: 5, difficult: 10 },
    impact: { supporting: 0, meaningful: 5, important: 10 },
    questCap: 70,
    levelBase: 100,
    levelGrowth: 25,
  },
};

export const DEFAULT_AREAS: Area[] = [
  { id: "area-university", name: "University", color: "#8B7CFF", icon: "GraduationCap", order: 0 },
  { id: "area-career", name: "Career", color: "#48A9FF", icon: "BriefcaseBusiness", order: 1 },
  { id: "area-projects", name: "Business & Projects", color: "#F59E5B", icon: "Rocket", order: 2 },
  { id: "area-health", name: "Health", color: "#38D69B", icon: "HeartPulse", order: 3 },
  { id: "area-money", name: "Money", color: "#EACB58", icon: "Landmark", order: 4 },
  { id: "area-personal", name: "Personal Development", color: "#D97AF5", icon: "Sparkles", order: 5 },
  { id: "area-social", name: "Social Life", color: "#FF7C9E", icon: "Users", order: 6 },
];

export const DEFAULT_STATS: LifeStat[] = [
  { id: "stat-knowledge", name: "Knowledge", color: "#8B7CFF", icon: "Brain", xp: 0 },
  { id: "stat-health", name: "Health", color: "#38D69B", icon: "HeartPulse", xp: 0 },
  { id: "stat-discipline", name: "Discipline", color: "#48A9FF", icon: "ShieldCheck", xp: 0 },
  { id: "stat-communication", name: "Communication", color: "#FF7C9E", icon: "MessagesSquare", xp: 0 },
  { id: "stat-creativity", name: "Creativity", color: "#D97AF5", icon: "Palette", xp: 0 },
  { id: "stat-finance", name: "Finance", color: "#EACB58", icon: "ChartNoAxesCombined", xp: 0 },
  { id: "stat-social", name: "Social", color: "#F59E5B", icon: "Users", xp: 0 },
  { id: "stat-technical", name: "Technical", color: "#4DD8E7", icon: "CodeXml", xp: 0 },
];

export function createStarterGoals(): Goal[] {
  const today = new Date();
  const inMonths = (months: number) => {
    const date = new Date(today);
    date.setMonth(date.getMonth() + months);
    return date.toISOString().slice(0, 10);
  };

  return [
    {
      id: "goal-evolvra",
      title: "Build my personal command centre",
      description: "Create a reliable system for seeing what matters, choosing the next action, and recording genuine development.",
      areaId: "area-projects",
      model: "weighted",
      priority: "high",
      targetDate: inMonths(2),
      status: "active",
      createdAt: now,
      metrics: [],
      milestones: [
        { id: "ms-setup", title: "Set up my life areas and stats", weight: 25, xp: 50, completed: true, completedAt: now },
        { id: "ms-goals", title: "Define my first three meaningful goals", weight: 30, xp: 100, completed: false },
        { id: "ms-rhythm", title: "Complete my first weekly review", weight: 20, xp: 100, completed: false },
        { id: "ms-month", title: "Use Evolvra for one full month", weight: 25, xp: 200, completed: false },
      ],
      quests: [
        {
          id: "quest-first-goal",
          title: "Add one real goal",
          description: "Choose an outcome that matters and define how progress will be measured.",
          effort: "standard",
          difficulty: "easy",
          impact: "meaningful",
          xp: 20,
          repeat: "none",
          completed: false,
          metricDeltas: [],
        },
        {
          id: "quest-check-in",
          title: "Write today’s check-in",
          effort: "quick",
          difficulty: "easy",
          impact: "supporting",
          xp: 5,
          repeat: "daily",
          completed: false,
          metricDeltas: [],
        },
      ],
      statWeights: { "stat-discipline": 40, "stat-knowledge": 20, "stat-technical": 40 },
      evidence: [],
      notes: "Keep the system honest, calm, and useful on difficult weeks.",
    },
    {
      id: "goal-fitness",
      title: "Build dependable cardiovascular fitness",
      description: "Develop a sustainable running habit without fragile streaks or punishment for missed days.",
      areaId: "area-health",
      model: "consistency",
      priority: "medium",
      targetDate: inMonths(4),
      status: "active",
      createdAt: now,
      metrics: [{ id: "metric-runs", label: "Sessions this month", current: 3, target: 12, unit: "runs", weight: 100 }],
      milestones: [
        { id: "ms-5k", title: "Complete a comfortable 5 km", weight: 50, xp: 100, completed: false },
        { id: "ms-month-fitness", title: "Complete 12 sessions in a month", weight: 50, xp: 200, completed: false },
      ],
      quests: [
        {
          id: "quest-run",
          title: "Complete an easy 30-minute run",
          effort: "focused",
          difficulty: "moderate",
          impact: "meaningful",
          xp: 40,
          repeat: "weekly",
          completed: false,
          durationMinutes: 30,
          metricDeltas: [{ metricId: "metric-runs", amount: 1 }],
        },
      ],
      statWeights: { "stat-health": 70, "stat-discipline": 30 },
      evidence: [],
      notes: "Aim for consistency over intensity.",
    },
    {
      id: "goal-savings",
      title: "Build a £2,000 opportunity fund",
      description: "Create financial breathing room for courses, travel, or a new project.",
      areaId: "area-money",
      model: "numeric",
      priority: "medium",
      targetDate: inMonths(6),
      status: "active",
      createdAt: now,
      metrics: [{ id: "metric-savings", label: "Saved", current: 650, target: 2000, unit: "£", weight: 100 }],
      milestones: [
        { id: "ms-1000", title: "Reach £1,000", weight: 50, xp: 100, completed: false },
        { id: "ms-2000", title: "Reach £2,000", weight: 50, xp: 300, completed: false },
      ],
      quests: [
        {
          id: "quest-budget",
          title: "Review this month’s spending",
          effort: "standard",
          difficulty: "easy",
          impact: "meaningful",
          xp: 20,
          repeat: "monthly",
          completed: false,
          metricDeltas: [],
        },
      ],
      statWeights: { "stat-finance": 70, "stat-discipline": 30 },
      evidence: [],
      notes: "Progress should come from real savings, not task completion.",
    },
  ];
}

export const EMPTY_STATE: AppState = {
  version: 1,
  updatedAt: now,
  profile: { displayName: "", chapter: "Building a life with direction", onboarded: false, createdAt: now },
  settings: DEFAULT_SETTINGS,
  areas: DEFAULT_AREAS,
  stats: DEFAULT_STATS,
  goals: [],
  reviews: [],
  timeline: [],
  overallXp: 0,
};
