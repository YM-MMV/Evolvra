"use client";

import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { useAppActions, useWorkspaceData } from "@/components/app-provider";
import { Button, Field, FieldGroup, Modal } from "@/components/ui";
import { WORKSPACE_TEXT_LIMITS } from "@/lib/state-schema";
import { terminologyForms } from "@/lib/terminology";
import type { Quest } from "@/lib/types";
import { isFiniteWorkspaceNumber, MAX_WORKSPACE_NUMBER, monthlyAnchorDayForSchedule, uid } from "@/lib/utils";

export function QuestForm({ goalId, open, onClose, quest }: { goalId: string; open: boolean; onClose: () => void; quest?: Quest }) {
  const { state } = useWorkspaceData();
  const { addQuest, updateGoal } = useAppActions();
  const goal = state.goals.find((item) => item.id === goalId);
  const terms = terminologyForms(state.settings.terminology);
  const initialMetricDeltaAmounts = Object.fromEntries(
    quest?.metricDeltas.map((delta) => [delta.metricId, String(delta.amount)]) ?? [],
  );
  const [kind, setKind] = useState<Quest["kind"]>(quest?.kind ?? "task");
  const [title, setTitle] = useState(quest?.title ?? "");
  const [description, setDescription] = useState(quest?.description ?? "");
  const [dueDate, setDueDate] = useState(quest?.dueDate ?? "");
  const [repeat, setRepeat] = useState<Quest["repeat"]>(quest?.repeat ?? "none");
  const [duration, setDuration] = useState(quest?.durationMinutes?.toString() ?? "");
  const [selectedMetricIds, setSelectedMetricIds] = useState<string[]>(
    quest?.metricDeltas.map((delta) => delta.metricId) ?? [],
  );
  const [metricDeltaAmounts, setMetricDeltaAmounts] = useState<Record<string, string>>(
    initialMetricDeltaAmounts,
  );
  const [linkedGoalIds, setLinkedGoalIds] = useState<string[]>(quest?.linkedGoalIds ?? []);
  const linkableGoals = state.goals.filter((item) => (
    item.id !== goalId && (item.status !== "archived" || linkedGoalIds.includes(item.id))
  ));
  const parsedDuration = duration.trim() ? Number(duration) : undefined;
  const durationValid = parsedDuration === undefined || isFiniteWorkspaceNumber(parsedDuration, 0);
  const metricDeltas = goal?.metrics
    .filter((metric) => selectedMetricIds.includes(metric.id))
    .map((metric) => ({
      metricId: metric.id,
      amount: Number(metricDeltaAmounts[metric.id]),
    })) ?? [];
  const metricDeltasValid = metricDeltas.length === selectedMetricIds.length
    && metricDeltas.every((delta) => (
      Boolean(metricDeltaAmounts[delta.metricId]?.trim())
      && isFiniteWorkspaceNumber(delta.amount)
    ));
  const toggleMetric = (metricId: string) => {
    setSelectedMetricIds((current) => (
      current.includes(metricId)
        ? current.filter((id) => id !== metricId)
        : [...current, metricId]
    ));
    setMetricDeltaAmounts((current) => (
      metricId in current ? current : { ...current, [metricId]: "1" }
    ));
  };
  const close = () => {
    setKind("task"); setTitle(""); setDescription(""); setDueDate(""); setRepeat("none"); setDuration(""); setSelectedMetricIds([]); setMetricDeltaAmounts({}); setLinkedGoalIds([]); onClose();
  };
  const submit = () => {
    if (!title.trim() || !durationValid || !metricDeltasValid) return;
    const monthlyAnchorDay = monthlyAnchorDayForSchedule(repeat, dueDate || undefined, quest);
    const next: Quest = {
      id: quest?.id ?? uid("quest"), kind, title: title.trim(), description: description.trim() || undefined, dueDate: dueDate || undefined,
      repeat, completed: quest?.completed ?? false, completedAt: quest?.completedAt, durationMinutes: parsedDuration,
      ...(monthlyAnchorDay === undefined ? {} : { monthlyAnchorDay }),
      linkedGoalIds: [...new Set(linkedGoalIds)].filter((linkedGoalId) => linkedGoalId !== goalId && state.goals.some((item) => item.id === linkedGoalId)),
      metricDeltas,
    };
    if (quest && goal) updateGoal(goalId, { quests: goal.quests.map((item) => item.id === quest.id ? next : item) });
    else addQuest(goalId, next);
    close();
  };

  return <Modal open={open} onClose={close} eyebrow={`Next useful ${terms.quests.singularLower}`} title={quest ? `Edit ${terms.quests.singularLower}` : `Create a ${terms.quests.singularLower}`}>
    <div className="form-stack">
      <Field label={`${terms.quests.singular} title`}><input data-modal-autofocus="true" maxLength={WORKSPACE_TEXT_LIMITS.actionTitle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Complete Spanish lesson 12" /></Field>
      <Field label="Notes" hint="Optional"><textarea rows={2} maxLength={WORKSPACE_TEXT_LIMITS.actionDescription} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does done look like?" /></Field>
      <Field label={`${terms.quests.singular} type`} hint={`Choose the shape of the ${terms.quests.singularLower}, independently of its schedule`}><select value={kind} onChange={(e) => setKind(e.target.value as Quest["kind"])}><option value="task">Task</option><option value="session">Session</option><option value="challenge">Challenge</option><option value="milestone">{terms.milestones.singular} {terms.quests.singularLower}</option></select></Field>
      <div className="form-grid"><Field label="Due date"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field><Field label="Repeats"><select value={repeat} onChange={(e) => setRepeat(e.target.value as Quest["repeat"])}><option value="none">One-off</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></Field></div>
      <Field label="Expected minutes" hint="Optional context for planning"><input type="number" min="0" max={MAX_WORKSPACE_NUMBER} value={duration} aria-invalid={!durationValid} onChange={(e) => setDuration(e.target.value)} placeholder="45" /></Field>
      {linkableGoals.length ? <FieldGroup label={`Also supports these ${terms.goals.pluralLower}`} hint={`Optional — the current ${terms.goals.singularLower} remains the primary home for this ${terms.quests.singularLower}.`}><div className="quality-list">{linkableGoals.map((linkedGoal) => { const selected = linkedGoalIds.includes(linkedGoal.id); const linkedArea = state.areas.find((area) => area.id === linkedGoal.areaId); return <button type="button" key={linkedGoal.id} className={selected ? "selected" : ""} aria-pressed={selected} onClick={() => setLinkedGoalIds((current) => selected ? current.filter((id) => id !== linkedGoal.id) : [...current, linkedGoal.id])}><i style={{ background: linkedArea?.color }} /><span>{linkedGoal.title}</span>{selected && <Check size={15} aria-hidden="true" />}</button>; })}</div></FieldGroup> : null}
      {goal?.metrics.length ? <FieldGroup label="Default metric changes" hint={`Optional — choose every measurement this reusable ${terms.quests.singularLower} normally changes. You can confirm the real amounts for each completion.`}>
        <div className="metric-default-list">
          {goal.metrics.map((metric) => {
            const selected = selectedMetricIds.includes(metric.id);
            const amount = metricDeltaAmounts[metric.id] ?? "";
            const amountValid = !selected || (
              amount.trim().length > 0
              && isFiniteWorkspaceNumber(Number(amount))
            );
            return <div key={metric.id} className={selected ? "metric-default-row selected" : "metric-default-row"}>
              <label className="metric-default-toggle">
                <input type="checkbox" checked={selected} onChange={() => toggleMetric(metric.id)} />
                <span><strong>{metric.label}</strong><small>{metric.unit || "No unit"}</small></span>
              </label>
              <Field label={`Default change to ${metric.label}`}>
                <input
                  type="number"
                  step="any"
                  min={-MAX_WORKSPACE_NUMBER}
                  max={MAX_WORKSPACE_NUMBER}
                  value={amount}
                  disabled={!selected}
                  aria-invalid={!amountValid}
                  onChange={(event) => setMetricDeltaAmounts((current) => ({
                    ...current,
                    [metric.id]: event.target.value,
                  }))}
                />
              </Field>
            </div>;
          })}
        </div>
      </FieldGroup> : null}
      {(!durationValid || !metricDeltasValid) && <p className="evidence-message" role="alert">Use a finite value within the supported range for every selected number before saving.</p>}
      <div className="setting-note"><Plus size={17} /><p>When completed, this {terms.quests.singularLower} will be recorded in the {terms.goals.singularLower} history with its date and every confirmed metric change.</p></div>
      <div className="button-row end"><Button variant="ghost" onClick={close}>Cancel</Button><Button disabled={!title.trim() || !durationValid || !metricDeltasValid} onClick={submit}><Plus size={16} /> {quest ? `Save ${terms.quests.singularLower}` : `Add ${terms.quests.singularLower}`}</Button></div>
    </div>
  </Modal>;
}
