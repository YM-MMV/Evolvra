"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, Check, CheckCircle2, Circle, Filter, Plus, Repeat2, Search } from "lucide-react";
import { useWorkspaceData } from "@/components/app-provider";
import { QuestCompletionForm } from "@/components/quest-completion-form";
import { EmptyState, Panel, Pill } from "@/components/ui";
import { completionAttribution, completionGoalIds } from "@/lib/activity-attribution";
import { terminologyForms } from "@/lib/terminology";
import type { Goal } from "@/lib/types";
import { formatDate, getArea, isQuestAvailable, localDateKey } from "@/lib/utils";

type QuestView = "available" | "completed" | "all";
type CompletionTarget = { goalId: string; questId: string };

const groupOrder = ["Today & overdue", "Anytime", "Upcoming", "Paused or inactive", "Completed"];

function connectedGoalsFor(primaryGoal: Goal, linkedGoalIds: string[], goalsById: Map<string, Goal>) {
  return [
    primaryGoal,
    ...(linkedGoalIds ?? [])
      .filter((goalId) => goalId !== primaryGoal.id)
      .map((goalId) => goalsById.get(goalId))
      .filter((goal): goal is Goal => Boolean(goal)),
  ];
}

export default function QuestsPage() {
  const { state } = useWorkspaceData();
  const [view, setView] = useState<QuestView>("available");
  const [areaId, setAreaId] = useState("all");
  const [query, setQuery] = useState("");
  const [completionTarget, setCompletionTarget] = useState<CompletionTarget | null>(null);
  const [visibleCompletions, setVisibleCompletions] = useState(50);
  const today = localDateKey();
  const terms = terminologyForms(state.settings.terminology);
  const goalsById = useMemo(() => new Map(state.goals.map((goal) => [goal.id, goal])), [state.goals]);

  const quests = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return state.goals
      .flatMap((goal) => goal.quests.map((quest) => ({
        quest,
        goal,
        connectedGoals: connectedGoalsFor(goal, quest.linkedGoalIds, goalsById),
      })))
      .filter(({ quest, goal, connectedGoals }) => {
        const available = goal.status === "active" && isQuestAvailable(quest);
        const stateMatch = view === "all" || available;
        const areaMatch = areaId === "all" || connectedGoals.some((connectedGoal) => connectedGoal.areaId === areaId);
        const searchMatch = !normalizedQuery || `${quest.title} ${quest.description ?? ""} ${connectedGoals.map((connectedGoal) => connectedGoal.title).join(" ")}`.toLowerCase().includes(normalizedQuery);
        return stateMatch && areaMatch && searchMatch;
      })
      .sort((a, b) => {
        const activeDifference = Number(b.goal.status === "active") - Number(a.goal.status === "active");
        if (activeDifference) return activeDifference;
        const completionDifference = Number(a.quest.completed) - Number(b.quest.completed);
        if (completionDifference) return completionDifference;
        return (a.quest.dueDate ?? "9999-12-31").localeCompare(b.quest.dueDate ?? "9999-12-31") || a.quest.title.localeCompare(b.quest.title);
      });
  }, [areaId, goalsById, query, state.goals, view]);

  const grouped = quests.reduce<Record<string, typeof quests>>((groups, item) => {
    const { goal, quest } = item;
    const key = quest.completed
      ? "Completed"
      : goal.status !== "active"
        ? "Paused or inactive"
        : isQuestAvailable(quest)
          ? quest.dueDate ? "Today & overdue" : "Anytime"
          : "Upcoming";
    groups[key] = [...(groups[key] ?? []), item];
    return groups;
  }, {});

  const completionHistory = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return state.questCompletions
      .map((completion) => {
        const goal = goalsById.get(completion.goalId);
        const attribution = completionAttribution(completion, state.goals, state.timeline);
        return {
          completion,
          goal,
          attribution,
          connectedGoals: completionGoalIds(completion)
            .map((goalId) => goalsById.get(goalId))
            .filter((connectedGoal): connectedGoal is Goal => Boolean(connectedGoal)),
        };
      })
      .filter(({ completion, goal, connectedGoals, attribution }) => {
        if (!goal || (areaId !== "all" && !attribution.areaIds.includes(areaId))) return false;
        const searchable = `${completion.title} ${connectedGoals.map((connectedGoal) => connectedGoal.title).join(" ")} ${completion.note ?? ""} ${completion.evidence.join(" ")}`.toLowerCase();
        return !normalizedQuery || searchable.includes(normalizedQuery);
      })
      .sort((a, b) => b.completion.completedAt.localeCompare(a.completion.completedAt));
  }, [areaId, goalsById, query, state.goals, state.questCompletions, state.timeline]);

  const selectedGoal = completionTarget ? state.goals.find((goal) => goal.id === completionTarget.goalId) : undefined;
  const selectedQuest = selectedGoal?.quests.find((quest) => quest.id === completionTarget?.questId);
  const canCompleteSelection = selectedGoal?.status === "active" && selectedQuest && isQuestAvailable(selectedQuest);

  return (
    <div className="instrument-route instrument-route-quests">
      <section className="page-header instrument-route-header">
        <div>
          <p className="eyebrow">Action register</p>
          <h1>{terms.quests.plural} board</h1>
          <p className="page-lead">Choose {terms.quests.pluralLower} that move a real {terms.goals.singularLower}. Missing a day never destroys your progress.</p>
        </div>
        <Link href="/goals" className="button button-primary"><Plus size={17} aria-hidden="true" /> Add through a {terms.goals.singularLower}</Link>
      </section>

      <div className="toolbar panel instrument-toolbar">
        <div className="search-box"><Search size={17} aria-hidden="true" /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCompletions(50); }} placeholder={`Search ${terms.quests.pluralLower}…`} aria-label={`Search ${terms.quests.pluralLower} and completion history`} /></div>
        <div className="filter-tabs" role="group" aria-label={`${terms.quests.singular} view`}>
          <button type="button" className={view === "available" ? "active" : ""} onClick={() => { setView("available"); setVisibleCompletions(50); }} aria-pressed={view === "available"}>Available</button>
          <button type="button" className={view === "completed" ? "active" : ""} onClick={() => { setView("completed"); setVisibleCompletions(50); }} aria-pressed={view === "completed"}>Completed</button>
          <button type="button" className={view === "all" ? "active" : ""} onClick={() => { setView("all"); setVisibleCompletions(50); }} aria-pressed={view === "all"}>All</button>
        </div>
        <label className="select-with-icon"><Filter size={15} aria-hidden="true" /><select value={areaId} onChange={(event) => { setAreaId(event.target.value); setVisibleCompletions(50); }} aria-label={`Filter ${terms.quests.pluralLower} by ${terms.areas.singularLower}`}><option value="all">Every {terms.areas.singularLower}</option>{state.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
      </div>

      {view === "completed" ? (
        !completionHistory.length ? (
          <EmptyState icon={<CheckCircle2 />} title={`No recorded ${terms.quests.pluralLower} yet`} body={`Completed one-off and repeating ${terms.quests.pluralLower} will appear here as a dated history.`} />
        ) : (
          <section aria-labelledby="completion-history-heading">
            <div className="section-heading compact"><div><p className="eyebrow">Completion history</p><h2 id="completion-history-heading">Recorded {terms.quests.pluralLower}</h2></div><span className="count-badge">{completionHistory.length}</span></div>
            <Panel className="quest-board-list">
              {completionHistory.slice(0, visibleCompletions).map(({ completion, goal, connectedGoals, attribution }) => {
                if (!goal) return null;
                const evidencePreview = completion.evidence.slice(0, 2).join(" · ");
                return (
                  <div key={completion.id} className="quest-board-row completed">
                    <span className="quest-check large" aria-hidden="true"><Check size={18} /></span>
                    <div className="quest-board-copy">
                      <strong>{completion.title}</strong>
                      {completion.note && <small title={completion.note}>{completion.note}</small>}
                      {evidencePreview && <small title={completion.evidence.join(" · ")}>Evidence: {evidencePreview}</small>}
                      {connectedGoals.map((connectedGoal) => { const connectedArea = getArea(state, connectedGoal.areaId); return <Link key={connectedGoal.id} href={`/goals/${connectedGoal.id}`} aria-label={`Open connected ${terms.goals.singularLower} ${connectedGoal.title}`}><i style={{ background: connectedArea?.color }} aria-hidden="true" />{connectedGoal.title}</Link>; })}
                    </div>
                    <div className="quest-tags">
                      <Pill><CalendarDays size={12} aria-hidden="true" /> <time dateTime={completion.completedAt}>{formatDate(completion.completedAt)}</time></Pill>
                      {completion.durationMinutes !== undefined && <Pill>{completion.durationMinutes} actual min</Pill>}
                      {completion.evidence.length > 0 && <Pill>{completion.evidence.length} evidence {completion.evidence.length === 1 ? "item" : "items"}</Pill>}
                      {completion.metricDeltas.length > 0 && <Pill>{completion.metricDeltas.length} metric {completion.metricDeltas.length === 1 ? "change" : "changes"}</Pill>}
                      {attribution.areaIds.flatMap((historicalAreaId) => {
                        const historicalArea = state.areas.find((area) => area.id === historicalAreaId);
                        return historicalArea ? [<Pill key={historicalArea.id}>At completion: {historicalArea.name}</Pill>] : [];
                      })}
                    </div>
                  </div>
                );
              })}
              {visibleCompletions < completionHistory.length && <button type="button" className="button button-secondary history-load-more" onClick={() => setVisibleCompletions((count) => count + 50)}>Load older completions ({completionHistory.length - visibleCompletions} remaining)</button>}
            </Panel>
          </section>
        )
      ) : !quests.length ? (
        <EmptyState
          icon={<CheckCircle2 />}
          title={view === "available" ? `No ${terms.quests.pluralLower} are due` : `No ${terms.quests.pluralLower} in this view`}
          body={view === "available" ? `A clear list is allowed. Add the next useful ${terms.quests.singularLower} when you are ready.` : `Adjust the filters or add a ${terms.quests.singularLower} through one of your ${terms.goals.pluralLower}.`}
        />
      ) : (
        <div className="quest-groups">
          {groupOrder.filter((group) => grouped[group]).map((group) => (
            <section key={group} aria-labelledby={`quest-group-${group.replaceAll(" ", "-").toLowerCase()}`}>
              <div className="section-heading compact">
                <div><p className="eyebrow">{group}</p><h2 id={`quest-group-${group.replaceAll(" ", "-").toLowerCase()}`}>{group === "Completed" ? `Completed ${terms.quests.pluralLower}` : group === "Paused or inactive" ? `Unavailable ${terms.quests.pluralLower}` : `${group} ${terms.quests.pluralLower}`}</h2></div>
                <span className="count-badge">{grouped[group].length}</span>
              </div>
              <Panel className="quest-board-list">
                {grouped[group].map(({ quest, goal, connectedGoals }) => {
                  const available = goal.status === "active" && isQuestAvailable(quest);
                  const dueLabel = quest.dueDate === today ? "Today" : quest.dueDate && quest.dueDate < today ? `Overdue · ${formatDate(quest.dueDate)}` : formatDate(quest.dueDate);
                  const actionLabel = quest.completed
                    ? `${quest.title} is already completed`
                    : goal.status !== "active"
                      ? `${quest.title} cannot be completed while ${goal.title} is ${goal.status}`
                      : available
                        ? `Record completion of ${quest.title}`
                        : `${quest.title} is available ${formatDate(quest.dueDate)}`;
                  return (
                    <div key={`${goal.id}-${quest.id}`} className={quest.completed ? "quest-board-row completed" : "quest-board-row"}>
                      <button
                        type="button"
                        className="quest-check large"
                        aria-label={actionLabel}
                        onClick={() => setCompletionTarget({ goalId: goal.id, questId: quest.id })}
                        disabled={!available}
                      >
                        {quest.completed ? <Check size={18} aria-hidden="true" /> : <Circle size={19} aria-hidden="true" />}
                      </button>
                      <div className="quest-board-copy">
                        <strong>{quest.title}</strong>
                        {quest.description && <small title={quest.description}>{quest.description}</small>}
                        {connectedGoals.map((connectedGoal) => { const connectedArea = getArea(state, connectedGoal.areaId); return <Link key={connectedGoal.id} href={`/goals/${connectedGoal.id}`} aria-label={`Open connected ${terms.goals.singularLower} ${connectedGoal.title}`}><i style={{ background: connectedArea?.color }} aria-hidden="true" />{connectedGoal.title}</Link>; })}
                      </div>
                      <div className="quest-tags">
                        {goal.status !== "active" && <Pill>{goal.status} {terms.goals.singularLower}</Pill>}
                        <Pill>{quest.kind}</Pill>
                        {quest.repeat !== "none" && <Pill><Repeat2 size={12} aria-hidden="true" /> {quest.repeat}</Pill>}
                        {quest.dueDate && <Pill><CalendarDays size={12} aria-hidden="true" /> <time dateTime={quest.dueDate}>{dueLabel}</time></Pill>}
                        {quest.repeat !== "none" && quest.completedAt && <Pill>Last completed {formatDate(quest.completedAt)}</Pill>}
                        {quest.durationMinutes !== undefined && <Pill>{quest.durationMinutes} planned min</Pill>}
                      </div>
                    </div>
                  );
                })}
              </Panel>
            </section>
          ))}
        </div>
      )}

      {completionTarget && canCompleteSelection && selectedQuest && (
        <QuestCompletionForm
          key={`${completionTarget.goalId}:${completionTarget.questId}`}
          goalId={completionTarget.goalId}
          quest={selectedQuest}
          open
          onClose={() => setCompletionTarget(null)}
        />
      )}
    </div>
  );
}
