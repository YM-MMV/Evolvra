"use client";

import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, Field, FieldGroup, Modal } from "@/components/ui";
import { WORKSPACE_TEXT_LIMITS } from "@/lib/state-schema";
import { terminologyForms } from "@/lib/terminology";
import type { Quest } from "@/lib/types";
import { isFiniteWorkspaceNumber, MAX_WORKSPACE_NUMBER, uid } from "@/lib/utils";

export function QuestForm({ goalId, open, onClose, quest }: { goalId: string; open: boolean; onClose: () => void; quest?: Quest }) {
  const { state, addQuest, updateGoal } = useApp();
  const goal = state.goals.find((item) => item.id === goalId);
  const terms = terminologyForms(state.settings.terminology);
  const linkedDelta = quest?.metricDeltas[0];
  const [kind, setKind] = useState<Quest["kind"]>(quest?.kind ?? "task");
  const [title, setTitle] = useState(quest?.title ?? "");
  const [description, setDescription] = useState(quest?.description ?? "");
  const [dueDate, setDueDate] = useState(quest?.dueDate ?? "");
  const [repeat, setRepeat] = useState<Quest["repeat"]>(quest?.repeat ?? "none");
  const [duration, setDuration] = useState(quest?.durationMinutes?.toString() ?? "");
  const [metricId, setMetricId] = useState(linkedDelta?.metricId ?? "");
  const [metricAmount, setMetricAmount] = useState(linkedDelta?.amount ?? 1);
  const [linkedGoalIds, setLinkedGoalIds] = useState<string[]>(quest?.linkedGoalIds ?? []);
  const linkableGoals = state.goals.filter((item) => (
    item.id !== goalId && (item.status !== "archived" || linkedGoalIds.includes(item.id))
  ));
  const parsedDuration = duration.trim() ? Number(duration) : undefined;
  const durationValid = parsedDuration === undefined || isFiniteWorkspaceNumber(parsedDuration, 0);
  const metricAmountValid = !metricId || isFiniteWorkspaceNumber(metricAmount);
  const close = () => {
    setKind("task"); setTitle(""); setDescription(""); setDueDate(""); setRepeat("none"); setDuration(""); setMetricId(""); setMetricAmount(1); setLinkedGoalIds([]); onClose();
  };
  const submit = () => {
    if (!title.trim() || !durationValid || !metricAmountValid) return;
    const next: Quest = {
      id: quest?.id ?? uid("quest"), kind, title: title.trim(), description: description.trim() || undefined, dueDate: dueDate || undefined,
      repeat, completed: quest?.completed ?? false, completedAt: quest?.completedAt, durationMinutes: parsedDuration,
      linkedGoalIds: [...new Set(linkedGoalIds)].filter((linkedGoalId) => linkedGoalId !== goalId && state.goals.some((item) => item.id === linkedGoalId)),
      metricDeltas: metricId ? [{ metricId, amount: metricAmount }] : [],
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
      {goal?.metrics.length ? <div className="form-grid"><Field label="Update a metric" hint="Optional"><select value={metricId} onChange={(e) => setMetricId(e.target.value)}><option value="">No automatic update</option>{goal.metrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}</select></Field><Field label="Amount"><input type="number" min={-MAX_WORKSPACE_NUMBER} max={MAX_WORKSPACE_NUMBER} value={metricAmount} disabled={!metricId} aria-invalid={!metricAmountValid} onChange={(e) => { const next = Number(e.target.value); setMetricAmount(isFiniteWorkspaceNumber(next) ? next : 0); }} /></Field></div> : null}
      {(!durationValid || !metricAmountValid) && <p className="evidence-message" role="alert">Use finite numbers within the supported range before saving.</p>}
      <div className="setting-note"><Plus size={17} /><p>When completed, this {terms.quests.singularLower} will be recorded in the {terms.goals.singularLower} history with its date and any linked metric change.</p></div>
      <div className="button-row end"><Button variant="ghost" onClick={close}>Cancel</Button><Button disabled={!title.trim() || !durationValid || !metricAmountValid} onClick={submit}><Plus size={16} /> {quest ? `Save ${terms.quests.singularLower}` : `Add ${terms.quests.singularLower}`}</Button></div>
    </div>
  </Modal>;
}
