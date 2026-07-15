"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createStarterGoals, EMPTY_STATE } from "@/lib/defaults";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";
import type {
  AppState,
  Area,
  Goal,
  GoalStatus,
  LifeStat,
  Quest,
  Review,
  TimelineEvent,
  UserSettings,
} from "@/lib/types";
import { levelFromXp, uid } from "@/lib/utils";

const STORAGE_KEY = "evolvra:workspace:v1";
const BACKUP_KEY = "evolvra:backups:v1";

type SyncStatus = "local" | "connecting" | "synced" | "saving" | "error";

interface AppContextValue {
  state: AppState;
  ready: boolean;
  user: User | null;
  syncStatus: SyncStatus;
  cloudEnabled: boolean;
  canUndo: boolean;
  completeOnboarding: (displayName: string, starter: boolean, birthDate?: string) => void;
  addGoal: (goal: Goal) => void;
  updateGoal: (goalId: string, patch: Partial<Goal>) => void;
  setGoalStatus: (goalId: string, status: GoalStatus) => void;
  deleteGoal: (goalId: string) => void;
  addQuest: (goalId: string, quest: Quest) => void;
  completeQuest: (goalId: string, questId: string) => void;
  toggleMilestone: (goalId: string, milestoneId: string) => void;
  updateMetric: (goalId: string, metricId: string, current: number) => void;
  addReview: (review: Review) => void;
  upsertArea: (area: Area) => void;
  removeArea: (areaId: string) => void;
  upsertStat: (stat: LifeStat) => void;
  removeStat: (statId: string) => void;
  updateSettings: (settings: Partial<UserSettings>) => void;
  updateProfile: (patch: Partial<AppState["profile"]>) => void;
  importState: (state: AppState) => void;
  resetWorkspace: () => void;
  undo: () => void;
  signIn: (email: string) => Promise<string>;
  signOut: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function nextRepeatDate(repeat: Quest["repeat"], from?: string) {
  const date = from ? new Date(from) : new Date();
  if (repeat === "daily") date.setDate(date.getDate() + 1);
  if (repeat === "weekly") date.setDate(date.getDate() + 7);
  if (repeat === "monthly") date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(supabaseConfigured ? "connecting" : "local");
  const [canUndo, setCanUndo] = useState(false);
  const history = useRef<AppState[]>([]);
  const skipPersist = useRef(true);
  const remoteLoaded = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setState(JSON.parse(saved) as AppState);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      } finally {
        setReady(true);
        skipPersist.current = false;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready || skipPersist.current) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [ready, state]);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;

    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (!session?.user) {
        remoteLoaded.current = false;
        setSyncStatus("local");
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase || !user || remoteLoaded.current) return;
    supabase
      .from("workspace_snapshots")
      .select("state,updated_at")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          setSyncStatus("error");
          return;
        }
        if (data?.state) {
          const remote = data.state as AppState;
          if (new Date(remote.updatedAt).getTime() > new Date(state.updatedAt).getTime()) setState(remote);
        }
        remoteLoaded.current = true;
        setSyncStatus("synced");
      });
  }, [state.updatedAt, user]);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase || !user || !remoteLoaded.current || !ready) return;
    const timer = window.setTimeout(async () => {
      setSyncStatus("saving");
      const { error } = await supabase.from("workspace_snapshots").upsert({
        user_id: user.id,
        state,
        updated_at: state.updatedAt,
      });
      setSyncStatus(error ? "error" : "synced");
    }, 900);
    return () => window.clearTimeout(timer);
  }, [ready, state, user]);

  const mutate = useCallback((recipe: (draft: AppState) => void) => {
    setCanUndo(true);
    setState((current) => {
      history.current = [...history.current.slice(-9), clone(current)];
      const draft = clone(current);
      recipe(draft);
      draft.updatedAt = new Date().toISOString();
      try {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(history.current.slice(-5)));
      } catch {
        // Storage may be unavailable in private browsing; the active state still works.
      }
      return draft;
    });
  }, []);

  const addTimeline = (draft: AppState, event: Omit<TimelineEvent, "id" | "at">) => {
    draft.timeline.unshift({ ...event, id: uid("event"), at: new Date().toISOString() });
    draft.timeline = draft.timeline.slice(0, 500);
  };

  const allocateXp = (draft: AppState, goal: Goal, xp: number, label: string) => {
    const overallBefore = levelFromXp(
      draft.overallXp,
      draft.settings.scoring.levelBase,
      draft.settings.scoring.levelGrowth,
    ).level;
    draft.overallXp += xp;

    Object.entries(goal.statWeights).forEach(([statId, weight]) => {
      const stat = draft.stats.find((item) => item.id === statId);
      if (!stat) return;
      const before = levelFromXp(stat.xp, draft.settings.scoring.levelBase, draft.settings.scoring.levelGrowth).level;
      stat.xp += (xp * weight) / 100;
      const after = levelFromXp(stat.xp, draft.settings.scoring.levelBase, draft.settings.scoring.levelGrowth).level;
      if (after > before) {
        addTimeline(draft, {
          type: "level",
          title: `${stat.name} reached level ${after}`,
          detail: `${label} helped develop ${stat.name}.`,
          goalId: goal.id,
          areaId: goal.areaId,
        });
      }
    });

    const overallAfter = levelFromXp(
      draft.overallXp,
      draft.settings.scoring.levelBase,
      draft.settings.scoring.levelGrowth,
    ).level;
    if (overallAfter > overallBefore) {
      addTimeline(draft, {
        type: "level",
        title: `Overall level ${overallAfter}`,
        detail: "Your accumulated effort opened a new level.",
        goalId: goal.id,
        areaId: goal.areaId,
      });
    }
  };

  const value: AppContextValue = {
      state,
      ready,
      user,
      syncStatus,
      cloudEnabled: supabaseConfigured,
      canUndo,
      completeOnboarding(displayName, starter, birthDate) {
        mutate((draft) => {
          draft.profile.displayName = displayName.trim() || "Explorer";
          draft.profile.onboarded = true;
          draft.settings.birthDate = birthDate;
          if (starter && !draft.goals.length) draft.goals = createStarterGoals();
          addTimeline(draft, {
            type: "note",
            title: "Evolvra journey started",
            detail: "Your command centre is ready to evolve with you.",
          });
        });
      },
      addGoal(goal) {
        mutate((draft) => {
          draft.goals.unshift(goal);
          addTimeline(draft, {
            type: "goal",
            title: `Created goal: ${goal.title}`,
            detail: `Progress will use the ${goal.model} model.`,
            goalId: goal.id,
            areaId: goal.areaId,
          });
        });
      },
      updateGoal(goalId, patch) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          if (!goal) return;
          Object.assign(goal, patch);
          addTimeline(draft, {
            type: "goal",
            title: `Updated ${goal.title}`,
            detail: "Goal structure or notes were adjusted without losing progress.",
            goalId,
            areaId: goal.areaId,
          });
        });
      },
      setGoalStatus(goalId, status) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          if (!goal || goal.status === status) return;
          const firstCompletion = status === "completed" && !goal.completedAt;
          goal.status = status;
          if (firstCompletion) {
            goal.completedAt = new Date().toISOString();
            allocateXp(draft, goal, 500, `Completing ${goal.title}`);
          }
          addTimeline(draft, {
            type: "goal",
            title: `${goal.title} ${status}`,
            detail: firstCompletion ? "Goal completed — 500 XP earned." : `Goal moved to ${status}.`,
            goalId,
            areaId: goal.areaId,
            xp: firstCompletion ? 500 : undefined,
          });
        });
      },
      deleteGoal(goalId) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          if (!goal) return;
          draft.goals = draft.goals.filter((item) => item.id !== goalId);
          addTimeline(draft, {
            type: "goal",
            title: `Archived record removed: ${goal.title}`,
            detail: "XP already earned remains intact.",
            areaId: goal.areaId,
          });
        });
      },
      addQuest(goalId, quest) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          if (!goal) return;
          goal.quests.unshift(quest);
          addTimeline(draft, {
            type: "note",
            title: `New quest: ${quest.title}`,
            detail: `${quest.xp} XP available.`,
            goalId,
            areaId: goal.areaId,
          });
        });
      },
      completeQuest(goalId, questId) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          const quest = goal?.quests.find((item) => item.id === questId);
          if (!goal || !quest || (quest.completed && quest.repeat === "none")) return;
          const completedAt = new Date().toISOString();
          quest.completedAt = completedAt;
          quest.completed = quest.repeat === "none";
          if (quest.repeat !== "none") quest.dueDate = nextRepeatDate(quest.repeat, quest.dueDate);
          quest.metricDeltas.forEach((delta) => {
            const metric = goal.metrics.find((item) => item.id === delta.metricId);
            if (metric) metric.current = Math.max(0, metric.current + delta.amount);
          });
          allocateXp(draft, goal, quest.xp, quest.title);
          addTimeline(draft, {
            type: "quest",
            title: quest.title,
            detail: `${quest.xp} XP earned${quest.durationMinutes ? ` · ${quest.durationMinutes} minutes invested` : ""}.`,
            goalId,
            areaId: goal.areaId,
            xp: quest.xp,
          });
        });
      },
      toggleMilestone(goalId, milestoneId) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          const milestone = goal?.milestones.find((item) => item.id === milestoneId);
          if (!goal || !milestone) return;
          if (milestone.completed) {
            milestone.completed = false;
            milestone.completedAt = undefined;
            return;
          }
          milestone.completed = true;
          milestone.completedAt = new Date().toISOString();
          allocateXp(draft, goal, milestone.xp, milestone.title);
          addTimeline(draft, {
            type: "milestone",
            title: milestone.title,
            detail: `Milestone reached — ${milestone.xp} XP earned.`,
            goalId,
            areaId: goal.areaId,
            xp: milestone.xp,
          });
        });
      },
      updateMetric(goalId, metricId, current) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          const metric = goal?.metrics.find((item) => item.id === metricId);
          if (!goal || !metric) return;
          metric.current = Math.max(0, current);
          addTimeline(draft, {
            type: "metric",
            title: `${metric.label} updated`,
            detail: `${metric.current} of ${metric.target} ${metric.unit}`,
            goalId,
            areaId: goal.areaId,
          });
        });
      },
      addReview(review) {
        mutate((draft) => {
          draft.reviews.unshift(review);
          addTimeline(draft, {
            type: "review",
            title: `${review.cadence[0].toUpperCase()}${review.cadence.slice(1)} review completed`,
            detail: "A calm reflection was added to your development record.",
          });
        });
      },
      upsertArea(area) {
        mutate((draft) => {
          const index = draft.areas.findIndex((item) => item.id === area.id);
          if (index >= 0) draft.areas[index] = area;
          else draft.areas.push(area);
        });
      },
      removeArea(areaId) {
        mutate((draft) => {
          const inUse = draft.goals.some((goal) => goal.areaId === areaId);
          const area = draft.areas.find((item) => item.id === areaId);
          if (!area) return;
          if (inUse) area.archived = true;
          else draft.areas = draft.areas.filter((item) => item.id !== areaId);
        });
      },
      upsertStat(stat) {
        mutate((draft) => {
          const index = draft.stats.findIndex((item) => item.id === stat.id);
          if (index >= 0) draft.stats[index] = stat;
          else draft.stats.push(stat);
        });
      },
      removeStat(statId) {
        mutate((draft) => {
          const inUse = draft.goals.some((goal) => goal.statWeights[statId]);
          const stat = draft.stats.find((item) => item.id === statId);
          if (!stat) return;
          if (inUse || stat.xp > 0) stat.archived = true;
          else draft.stats = draft.stats.filter((item) => item.id !== statId);
        });
      },
      updateSettings(settings) {
        mutate((draft) => {
          draft.settings = { ...draft.settings, ...settings };
        });
      },
      updateProfile(patch) {
        mutate((draft) => Object.assign(draft.profile, patch));
      },
      importState(imported) {
        if (!imported?.version || !imported.profile || !Array.isArray(imported.goals)) throw new Error("Invalid Evolvra export");
        history.current.push(clone(state));
        setCanUndo(true);
        setState({ ...imported, updatedAt: new Date().toISOString() });
      },
      resetWorkspace() {
        history.current.push(clone(state));
        setCanUndo(true);
        setState({ ...clone(EMPTY_STATE), updatedAt: new Date().toISOString() });
      },
      undo() {
        const previous = history.current.pop();
        if (previous) {
          setState({ ...previous, updatedAt: new Date().toISOString() });
          setCanUndo(history.current.length > 0);
        }
      },
      async signIn(email) {
        const supabase = getSupabase();
        if (!supabase) throw new Error("Add Supabase environment variables first.");
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        return "Check your email for a secure sign-in link.";
      },
      async signOut() {
        await getSupabase()?.auth.signOut();
        setUser(null);
        setSyncStatus("local");
      },
    };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}
