import { goalProgressConfigurationIssue } from "@/lib/goal-progress";
import type {
  AppState,
  AttributionSnapshot,
  MetricEntry,
  QuestCompletion,
} from "@/lib/types";

function addInferredCompletions(state: AppState) {
  const seen = new Set(
    state.questCompletions.map((completion) => (
      `${completion.goalId}\u0000${completion.questId}\u0000${completion.completedAt}`
    )),
  );

  const add = (completion: QuestCompletion) => {
    const key = `${completion.goalId}\u0000${completion.questId}\u0000${completion.completedAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    state.questCompletions.push(completion);
  };

  state.timeline.forEach((event) => {
    if (event.type !== "quest" || !event.goalId) return;
    const goal = state.goals.find((item) => item.id === event.goalId);
    const quest = goal?.quests.find((item) => item.title === event.title);
    if (!goal || !quest) return;
    add({
      id: `completion-${event.id}`,
      goalId: goal.id,
      linkedGoalIds: quest.linkedGoalIds,
      questId: quest.id,
      title: quest.title,
      completedAt: event.at,
      evidence: [],
      metricDeltas: [],
      ...(quest.durationMinutes === undefined ? {} : { durationMinutes: quest.durationMinutes }),
    });
  });

  state.goals.forEach((goal) => {
    goal.quests.forEach((quest) => {
      if (!quest.completedAt) return;
      add({
        id: `completion-${goal.id}-${quest.id}`,
        goalId: goal.id,
        linkedGoalIds: quest.linkedGoalIds,
        questId: quest.id,
        title: quest.title,
        completedAt: quest.completedAt,
        evidence: [],
        metricDeltas: quest.metricDeltas,
        ...(quest.durationMinutes === undefined ? {} : { durationMinutes: quest.durationMinutes }),
      });
    });
  });

  state.questCompletions.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}

/**
 * Applies cross-collection repairs after tolerant field sanitization.
 *
 * Keeping these repairs together makes the version-dependent migration step
 * explicit while the state schema remains the sole public import boundary.
 */
export function finalizeMigratedState(
  state: AppState,
  sourceVersion: number,
  currentVersion: AppState["version"],
): AppState {
  const statIds = new Set(state.stats.map((stat) => stat.id));
  const goalIds = new Set(state.goals.map((goal) => goal.id));
  state.goals.forEach((goal) => {
    goal.statIds = goal.statIds.filter((statId) => statIds.has(statId));
    goal.quests.forEach((quest) => {
      quest.linkedGoalIds = quest.linkedGoalIds.filter((linkedGoalId) => (
        linkedGoalId !== goal.id && goalIds.has(linkedGoalId)
      ));
    });
  });

  const goalsById = new Map(state.goals.map((goal) => [goal.id, goal]));
  state.questCompletions.forEach((completion) => {
    completion.linkedGoalIds = completion.linkedGoalIds.filter((linkedGoalId) => (
      linkedGoalId !== completion.goalId && goalsById.has(linkedGoalId)
    ));
    const relatedGoalIds = [completion.goalId, ...completion.linkedGoalIds];
    const existingSnapshots = new Map(
      completion.goalSnapshots?.map((snapshot) => [snapshot.goalId, snapshot]),
    );
    completion.goalSnapshots = relatedGoalIds.flatMap((goalId) => {
      const existing = existingSnapshots.get(goalId);
      if (existing) return [existing];
      const goal = goalsById.get(goalId);
      return goal ? [{ goalId, areaId: goal.areaId, statIds: [...goal.statIds] }] : [];
    });
  });

  state.metricEntries.forEach((entry) => {
    const contextualEntry = entry as MetricEntry & { label?: string; unit?: string };
    const goal = goalsById.get(entry.goalId);
    const metric = goal?.metrics.find((item) => item.id === entry.metricId);
    if (!entry.attribution && goal) {
      entry.attribution = { areaId: goal.areaId, statIds: [...goal.statIds] };
    }
    if (!metric) return;
    if (!contextualEntry.label) contextualEntry.label = metric.label.trim().slice(0, 120);
    if (!contextualEntry.unit && metric.unit.trim()) {
      contextualEntry.unit = metric.unit.trim().slice(0, 32);
    }
  });

  state.timeline.forEach((event) => {
    const relatedGoalIds = [...new Set([
      ...(event.goalId ? [event.goalId] : []),
      ...(event.relatedGoalIds ?? []),
    ])];
    const relatedGoals = relatedGoalIds.flatMap((goalId) => {
      const goal = goalsById.get(goalId);
      return goal ? [goal] : [];
    });
    const explicitAreaIds = [...new Set([
      ...(event.areaId ? [event.areaId] : []),
      ...(event.relatedAreaIds ?? []),
    ])];
    const relatedAreaIds = explicitAreaIds.length
      ? explicitAreaIds
      : [...new Set(relatedGoals.map((goal) => goal.areaId))];
    const relatedStatIds = event.relatedStatIds?.length
      ? [...new Set(event.relatedStatIds)]
      : [...new Set(relatedGoals.flatMap((goal) => goal.statIds))];
    if (relatedGoalIds.length) event.relatedGoalIds = relatedGoalIds;
    if (relatedAreaIds.length) event.relatedAreaIds = relatedAreaIds;
    if (relatedStatIds.length) event.relatedStatIds = relatedStatIds;
  });

  if (sourceVersion < currentVersion) addInferredCompletions(state);
  return state;
}

/**
 * Confirms that the fully migrated graph still has valid cross-collection
 * references before the public import boundary accepts it.
 */
export function assertMigratedStateCoherence(
  state: AppState,
  sourceVersion: number,
  fail: (message: string) => never,
): void {
  const areaIds = new Set(state.areas.map((area) => area.id));
  const statIds = new Set(state.stats.map((stat) => stat.id));
  const goals = new Map(state.goals.map((goal) => [goal.id, goal]));
  const assertAttributionReferences = (
    attribution: AttributionSnapshot,
    label: string,
  ) => {
    if (!areaIds.has(attribution.areaId)) {
      fail(`${label} references missing area "${attribution.areaId}".`);
    }
    attribution.statIds.forEach((statId) => {
      if (!statIds.has(statId)) {
        fail(`${label} references missing quality "${statId}".`);
      }
    });
  };

  state.goals.forEach((goal) => {
    if (!areaIds.has(goal.areaId)) {
      fail(`goal "${goal.id}" references missing area "${goal.areaId}".`);
    }
    if (
      goal.completionSnapshot
      && (
        !goal.completedAt
        || new Date(goal.completionSnapshot.completedAt).getTime()
          !== new Date(goal.completedAt).getTime()
      )
    ) {
      fail(`goal "${goal.id}" completion snapshot does not match its first completion time.`);
    }
    const progressIssue = goalProgressConfigurationIssue(goal);
    if (progressIssue) fail(`goal "${goal.id}" is inconsistent: ${progressIssue}`);
    goal.statIds.forEach((statId) => {
      if (!statIds.has(statId)) {
        fail(`goal "${goal.id}" references missing quality "${statId}".`);
      }
    });
    const metricIds = new Set(goal.metrics.map((metric) => metric.id));
    goal.quests.forEach((quest) => {
      quest.metricDeltas.forEach((delta) => {
        if (!metricIds.has(delta.metricId)) {
          fail(`action "${quest.id}" references missing metric "${delta.metricId}".`);
        }
      });
      quest.linkedGoalIds.forEach((linkedGoalId) => {
        if (linkedGoalId === goal.id) {
          fail(`action "${quest.id}" cannot link primary goal "${goal.id}" as an additional goal.`);
        }
        if (!goals.has(linkedGoalId)) {
          fail(`action "${quest.id}" references missing linked goal "${linkedGoalId}".`);
        }
      });
    });
    goal.milestones.forEach((milestone) => {
      if (milestone.attribution) {
        assertAttributionReferences(
          milestone.attribution,
          `milestone "${milestone.id}" attribution`,
        );
      }
    });
    goal.checkIns.forEach((checkIn) => {
      if (checkIn.attribution) {
        assertAttributionReferences(
          checkIn.attribution,
          `check-in "${checkIn.id}" attribution`,
        );
      }
    });
  });

  if (sourceVersion < 2) return;

  const completions = new Map(
    state.questCompletions.map((completion) => [completion.id, completion]),
  );
  const linkedMetricSources = new Set<string>();
  state.questCompletions.forEach((completion) => {
    if (!goals.has(completion.goalId)) {
      fail(`action history "${completion.id}" references missing goal "${completion.goalId}".`);
    }
    completion.linkedGoalIds.forEach((linkedGoalId) => {
      if (linkedGoalId === completion.goalId) {
        fail(`action history "${completion.id}" cannot link primary goal "${completion.goalId}" as an additional goal.`);
      }
      if (!goals.has(linkedGoalId)) {
        fail(`action history "${completion.id}" references missing linked goal "${linkedGoalId}".`);
      }
    });
    completion.goalSnapshots?.forEach((snapshot) => {
      if (!goals.has(snapshot.goalId)) {
        fail(`action history "${completion.id}" attribution references missing goal "${snapshot.goalId}".`);
      }
      assertAttributionReferences(
        snapshot,
        `action history "${completion.id}" attribution`,
      );
    });
  });
  state.metricEntries.forEach((entry) => {
    if (!goals.has(entry.goalId)) {
      fail(`metric history "${entry.id}" references missing goal "${entry.goalId}".`);
    }
    if (entry.sourceCompletionId) {
      const completion = completions.get(entry.sourceCompletionId);
      if (!completion || completion.goalId !== entry.goalId || entry.source !== "quest") {
        fail(`metric history "${entry.id}" has an invalid source completion link.`);
      }
      const sourceDelta = completion.metricDeltas.find(
        (delta) => delta.metricId === entry.metricId,
      );
      if (!sourceDelta || sourceDelta.amount !== entry.value - entry.previousValue) {
        fail(`metric history "${entry.id}" does not match its source completion delta.`);
      }
      const sourceKey = `${entry.sourceCompletionId}\u0000${entry.metricId}`;
      if (linkedMetricSources.has(sourceKey)) {
        fail("metric history contains a duplicate source completion and metric link.");
      }
      linkedMetricSources.add(sourceKey);
    }
    if (entry.attribution) {
      assertAttributionReferences(
        entry.attribution,
        `metric history "${entry.id}" attribution`,
      );
    }
  });
  state.timeline.forEach((event) => {
    if (event.goalId && !goals.has(event.goalId)) {
      fail(`timeline event "${event.id}" references missing goal "${event.goalId}".`);
    }
    event.relatedGoalIds?.forEach((goalId) => {
      if (!goals.has(goalId)) {
        fail(`timeline event "${event.id}" attribution references missing goal "${goalId}".`);
      }
    });
    event.relatedAreaIds?.forEach((areaId) => {
      if (!areaIds.has(areaId)) {
        fail(`timeline event "${event.id}" attribution references missing area "${areaId}".`);
      }
    });
    event.relatedStatIds?.forEach((statId) => {
      if (!statIds.has(statId)) {
        fail(`timeline event "${event.id}" attribution references missing quality "${statId}".`);
      }
    });
  });
}
