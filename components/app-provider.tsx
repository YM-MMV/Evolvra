"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createStarterGoals, EMPTY_STATE } from "@/lib/defaults";
import { migrateState } from "@/lib/state-schema";
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
import { isQuestAvailable, nextRepeatDate, uid } from "@/lib/utils";

const LEGACY_STORAGE_KEY = "evolvra:workspace:v1";
const storageKey = (accountId: string | null) => `evolvra:workspace:v2:${accountId ?? "anonymous"}`;
const backupKey = (accountId: string | null) => `evolvra:backups:v2:${accountId ?? "anonymous"}`;

type SyncStatus = "local" | "connecting" | "synced" | "saving" | "error";

interface AppContextValue {
  state: AppState;
  ready: boolean;
  user: User | null;
  syncStatus: SyncStatus;
  cloudEnabled: boolean;
  persistenceError: string | null;
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
  addCheckIn: (goalId: string, note: string) => void;
  addReview: (review: Review) => void;
  upsertArea: (area: Area) => void;
  removeArea: (areaId: string) => void;
  upsertStat: (stat: LifeStat) => void;
  removeStat: (statId: string) => void;
  updateSettings: (settings: Partial<UserSettings>) => void;
  updateProfile: (patch: Partial<AppState["profile"]>) => void;
  importState: (state: unknown) => void;
  resetWorkspace: () => void;
  undo: () => void;
  signIn: (email: string) => Promise<string>;
  signOut: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(supabaseConfigured ? "connecting" : "local");
  const [canUndo, setCanUndo] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const history = useRef<AppState[]>([]);
  const skipPersist = useRef(true);
  const remoteLoaded = useRef(false);
  const activeAccount = useRef<string | null>(null);
  const accountSwitching = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem(storageKey(null)) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
        if (saved) setState(migrateState(JSON.parse(saved)));
      } catch {
        const backups = localStorage.getItem(backupKey(null));
        if (backups) {
          try {
            const parsed = JSON.parse(backups);
            if (Array.isArray(parsed) && parsed.length) setState(migrateState(parsed.at(-1)));
          } catch {
            setPersistenceError("Saved data could not be read. A safe empty workspace was opened.");
          }
        } else {
          setPersistenceError("Saved data could not be read. A safe empty workspace was opened.");
        }
      } finally {
        setReady(true);
        skipPersist.current = false;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready || skipPersist.current) return;
    try {
      localStorage.setItem(storageKey(activeAccount.current), JSON.stringify(state));
      const timer = window.setTimeout(() => setPersistenceError(null), 0);
      return () => window.clearTimeout(timer);
    } catch {
      const timer = window.setTimeout(() => setPersistenceError("This change is still open in memory but could not be saved on this device. Export a backup before closing the app."), 0);
      return () => window.clearTimeout(timer);
    }
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
    if (!ready) return;
    const nextAccount = user?.id ?? null;
    if (activeAccount.current === nextAccount) return;
    accountSwitching.current = true;
    activeAccount.current = nextAccount;
    remoteLoaded.current = false;
    history.current = [];
    const timer = window.setTimeout(() => {
      setCanUndo(false);
      try {
        const saved = localStorage.getItem(storageKey(nextAccount));
        if (saved) setState(migrateState(JSON.parse(saved)));
        else if (!nextAccount) setState(clone(EMPTY_STATE));
      } catch {
        setState(clone(EMPTY_STATE));
        setPersistenceError("This account's local workspace could not be read, so a safe empty copy was opened.");
      } finally {
        accountSwitching.current = false;
        setAccountEpoch((value) => value + 1);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ready, user?.id]);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase || !user || remoteLoaded.current || !ready || accountSwitching.current) return;
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
          const remote = migrateState(data.state);
          if (new Date(remote.updatedAt).getTime() > new Date(state.updatedAt).getTime()) setState(remote);
        } else {
          setSyncStatus("saving");
          void supabase.from("workspace_snapshots").upsert({ user_id: user.id, state }).then(({ error: uploadError }) => {
            setSyncStatus(uploadError ? "error" : "synced");
          });
        }
        remoteLoaded.current = true;
        if (data?.state) setSyncStatus("synced");
      });
  }, [accountEpoch, ready, state, user]);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase || !user || !remoteLoaded.current || !ready) return;
    const timer = window.setTimeout(async () => {
      setSyncStatus("saving");
      const { error } = await supabase.from("workspace_snapshots").upsert({
        user_id: user.id,
        state,
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
        localStorage.setItem(backupKey(activeAccount.current), JSON.stringify(history.current.slice(-5)));
      } catch {
        // Storage may be unavailable in private browsing; the active state still works.
      }
      return draft;
    });
  }, []);

  const addTimeline = (draft: AppState, event: Omit<TimelineEvent, "id" | "at">) => {
    draft.timeline.unshift({ ...event, id: uid("event"), at: new Date().toISOString() });
  };

  const value: AppContextValue = {
      state,
      ready,
      user,
      syncStatus,
      cloudEnabled: supabaseConfigured,
      persistenceError,
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
          if (firstCompletion) goal.completedAt = new Date().toISOString();
          addTimeline(draft, {
            type: "goal",
            title: `${goal.title} ${status}`,
            detail: firstCompletion ? "Goal completed and added to your permanent record." : `Goal moved to ${status}.`,
            goalId,
            areaId: goal.areaId,
          });
        });
      },
      deleteGoal(goalId) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          if (!goal) return;
          draft.goals = draft.goals.filter((item) => item.id !== goalId);
          draft.questCompletions = draft.questCompletions.filter((item) => item.goalId !== goalId);
          draft.metricEntries = draft.metricEntries.filter((item) => item.goalId !== goalId);
          draft.timeline = draft.timeline.filter((item) => item.goalId !== goalId);
          addTimeline(draft, {
            type: "goal",
            title: `Removed goal: ${goal.title}`,
            detail: "The goal and its connected activity records were removed from this workspace.",
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
            detail: quest.dueDate ? `Planned for ${quest.dueDate}.` : "Ready when it is useful.",
            goalId,
            areaId: goal.areaId,
          });
        });
      },
      completeQuest(goalId, questId) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          const quest = goal?.quests.find((item) => item.id === questId);
          if (!goal || !quest || !isQuestAvailable(quest)) return;
          const completedAt = new Date().toISOString();
          quest.completedAt = completedAt;
          quest.completed = quest.repeat === "none";
          if (quest.repeat !== "none") quest.dueDate = nextRepeatDate(quest.repeat, quest.dueDate);
          draft.questCompletions.unshift({
            id: uid("completion"),
            goalId,
            questId,
            title: quest.title,
            completedAt,
            ...(quest.durationMinutes === undefined ? {} : { durationMinutes: quest.durationMinutes }),
          });
          quest.metricDeltas.forEach((delta) => {
            const metric = goal.metrics.find((item) => item.id === delta.metricId);
            if (!metric) return;
            const previousValue = metric.current;
            metric.current = Math.max(0, metric.current + delta.amount);
            draft.metricEntries.unshift({
              id: uid("metric-entry"),
              goalId,
              metricId: metric.id,
              previousValue,
              value: metric.current,
              recordedAt: completedAt,
              source: "quest",
            });
          });
          addTimeline(draft, {
            type: "quest",
            title: quest.title,
            detail: `Action completed${quest.durationMinutes ? ` · ${quest.durationMinutes} minutes invested` : ""}.`,
            goalId,
            areaId: goal.areaId,
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
          addTimeline(draft, {
            type: "milestone",
            title: milestone.title,
            detail: "Milestone reached and recorded.",
            goalId,
            areaId: goal.areaId,
          });
        });
      },
      updateMetric(goalId, metricId, current) {
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          const metric = goal?.metrics.find((item) => item.id === metricId);
          if (!goal || !metric) return;
          const previousValue = metric.current;
          metric.current = Math.max(0, current);
          if (metric.current === previousValue) return;
          draft.metricEntries.unshift({
            id: uid("metric-entry"),
            goalId,
            metricId,
            previousValue,
            value: metric.current,
            recordedAt: new Date().toISOString(),
            source: "manual",
          });
          addTimeline(draft, {
            type: "metric",
            title: `${metric.label} updated`,
            detail: `${metric.current} of ${metric.target} ${metric.unit}`,
            goalId,
            areaId: goal.areaId,
          });
        });
      },
      addCheckIn(goalId, note) {
        if (!note.trim()) return;
        mutate((draft) => {
          const goal = draft.goals.find((item) => item.id === goalId);
          if (!goal) return;
          const createdAt = new Date().toISOString();
          goal.checkIns.unshift({ id: uid("check-in"), createdAt, note: note.trim() });
          addTimeline(draft, {
            type: "note",
            title: `Check-in for ${goal.title}`,
            detail: note.trim(),
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
          const inUse = draft.goals.some((goal) => goal.statIds.includes(statId));
          const stat = draft.stats.find((item) => item.id === statId);
          if (!stat) return;
          if (inUse) stat.archived = true;
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
        const migrated = migrateState(imported);
        if (!migrated.profile || !Array.isArray(migrated.goals)) throw new Error("Invalid Evolvra export");
        history.current.push(clone(state));
        setCanUndo(true);
        setState({ ...migrated, updatedAt: new Date().toISOString() });
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
        const { error } = await getSupabase()?.auth.signOut() ?? { error: null };
        if (error) throw error;
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
