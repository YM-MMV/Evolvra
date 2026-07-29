import {
  addCheckInDraft,
  addGoalDraft,
  addQuestDraft,
  addReviewDraft,
  completeOnboardingDraft,
  completeQuestDraft,
  normalizeSettingsPatch,
  removeAreaDraft,
  removeStatDraft,
  reorderAreasDraft,
  reorderStatsDraft,
  setGoalStatusDraft,
  toggleMilestoneDraft,
  updateGoalDraft,
  updateMetricDraft,
  updateProfileDraft,
  updateSettingsDraft,
  upsertAreaDraft,
  upsertStatDraft,
  type ProviderCommandRuntime,
} from "@/lib/provider-domain-commands";
import { cloneWorkspaceValue } from "@/lib/provider-state";
import type {
  AppState,
  Area,
  Goal,
  GoalStatus,
  LifeStat,
  Quest,
  QuestCompletionInput,
  Review,
  UserSettings,
} from "@/lib/types";
import { isFiniteWorkspaceNumber } from "@/lib/utils";

export interface WorkspaceMutationPort {
  mutate: (recipe: (draft: AppState) => void) => void;
}

export interface ProviderDomainActions {
  completeOnboarding: (displayName: string, starter: boolean, birthDate?: string) => void;
  addGoal: (goal: Goal) => void;
  updateGoal: (goalId: string, patch: Partial<Goal>) => void;
  setGoalStatus: (goalId: string, status: GoalStatus) => void;
  addQuest: (goalId: string, quest: Quest) => void;
  completeQuest: (goalId: string, questId: string, input?: QuestCompletionInput) => void;
  toggleMilestone: (goalId: string, milestoneId: string) => void;
  updateMetric: (goalId: string, metricId: string, current: number) => void;
  addCheckIn: (goalId: string, note: string) => void;
  addReview: (review: Review) => void;
  upsertArea: (area: Area) => void;
  reorderAreas: (areaIds: string[]) => void;
  removeArea: (areaId: string) => void;
  upsertStat: (stat: LifeStat) => void;
  reorderStats: (statIds: string[]) => void;
  removeStat: (statId: string) => void;
  updateSettings: (settings: Partial<UserSettings>) => void;
  updateProfile: (patch: Partial<AppState["profile"]>) => void;
}

/**
 * Bind the pure domain recipes to the provider's mutation boundary.
 *
 * File operations, account lifecycle, imports, recovery, and erasure stay
 * outside this adapter because they require durability or scope coordination.
 */
export function createProviderDomainActions(
  port: WorkspaceMutationPort,
  runtime?: ProviderCommandRuntime,
): ProviderDomainActions {
  return {
    completeOnboarding(displayName, starter, birthDate) {
      port.mutate((draft) => {
        completeOnboardingDraft(draft, displayName, starter, birthDate, runtime);
      });
    },
    addGoal(goal) {
      const safeGoal = cloneWorkspaceValue(goal);
      port.mutate((draft) => addGoalDraft(draft, safeGoal, runtime));
    },
    updateGoal(goalId, patch) {
      const safePatch = cloneWorkspaceValue(patch);
      port.mutate((draft) => updateGoalDraft(draft, goalId, safePatch, runtime));
    },
    setGoalStatus(goalId, status) {
      port.mutate((draft) => setGoalStatusDraft(draft, goalId, status, runtime));
    },
    addQuest(goalId, quest) {
      const safeQuest = cloneWorkspaceValue(quest);
      port.mutate((draft) => addQuestDraft(draft, goalId, safeQuest, runtime));
    },
    completeQuest(goalId, questId, input = {}) {
      const safeInput = cloneWorkspaceValue(input);
      port.mutate((draft) => completeQuestDraft(
        draft,
        goalId,
        questId,
        safeInput,
        runtime,
      ));
    },
    toggleMilestone(goalId, milestoneId) {
      port.mutate((draft) => toggleMilestoneDraft(draft, goalId, milestoneId, runtime));
    },
    updateMetric(goalId, metricId, current) {
      if (!isFiniteWorkspaceNumber(current, 0)) return;
      port.mutate((draft) => updateMetricDraft(draft, goalId, metricId, current, runtime));
    },
    addCheckIn(goalId, note) {
      if (!note.trim()) return;
      port.mutate((draft) => addCheckInDraft(draft, goalId, note, runtime));
    },
    addReview(review) {
      const safeReview = cloneWorkspaceValue(review);
      port.mutate((draft) => addReviewDraft(draft, safeReview, runtime));
    },
    upsertArea(area) {
      const safeArea = cloneWorkspaceValue(area);
      port.mutate((draft) => upsertAreaDraft(draft, safeArea));
    },
    reorderAreas(areaIds) {
      const safeAreaIds = cloneWorkspaceValue(areaIds);
      port.mutate((draft) => reorderAreasDraft(draft, safeAreaIds));
    },
    removeArea(areaId) {
      port.mutate((draft) => removeAreaDraft(draft, areaId));
    },
    upsertStat(stat) {
      const safeStat = cloneWorkspaceValue(stat);
      port.mutate((draft) => upsertStatDraft(draft, safeStat));
    },
    reorderStats(statIds) {
      const safeStatIds = cloneWorkspaceValue(statIds);
      port.mutate((draft) => reorderStatsDraft(draft, safeStatIds));
    },
    removeStat(statId) {
      port.mutate((draft) => removeStatDraft(draft, statId));
    },
    updateSettings(settings) {
      const { clearBirthDate, safeSettings } = normalizeSettingsPatch(settings);
      port.mutate((draft) => updateSettingsDraft(draft, safeSettings, clearBirthDate));
    },
    updateProfile(patch) {
      const safePatch = cloneWorkspaceValue(patch);
      port.mutate((draft) => updateProfileDraft(draft, safePatch));
    },
  };
}
