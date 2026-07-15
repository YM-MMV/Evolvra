"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, Field, Modal } from "@/components/ui";
import type { Quest, QuestDifficulty, QuestEffort, QuestImpact } from "@/lib/types";
import { questXp, uid } from "@/lib/utils";

export function QuestForm({ goalId, open, onClose }: { goalId: string; open: boolean; onClose: () => void }) {
  const { state, addQuest } = useApp();
  const goal = state.goals.find((item) => item.id === goalId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [repeat, setRepeat] = useState<Quest["repeat"]>("none");
  const [effort, setEffort] = useState<QuestEffort>("standard");
  const [difficulty, setDifficulty] = useState<QuestDifficulty>("moderate");
  const [impact, setImpact] = useState<QuestImpact>("meaningful");
  const [duration, setDuration] = useState("");
  const [metricId, setMetricId] = useState("");
  const [metricAmount, setMetricAmount] = useState(1);
  const xp = questXp({ effort, difficulty, impact }, state.settings.scoring);

  const close = () => {
    setTitle(""); setDescription(""); setDueDate(""); setRepeat("none"); setEffort("standard"); setDifficulty("moderate"); setImpact("meaningful"); setDuration(""); setMetricId(""); setMetricAmount(1); onClose();
  };
  const submit = () => {
    if (!title.trim()) return;
    addQuest(goalId, {
      id: uid("quest"), title: title.trim(), description: description.trim() || undefined, dueDate: dueDate || undefined,
      repeat, effort, difficulty, impact, xp, completed: false, durationMinutes: duration ? Number(duration) : undefined,
      metricDeltas: metricId ? [{ metricId, amount: metricAmount }] : [],
    });
    close();
  };

  return <Modal open={open} onClose={close} eyebrow="Next useful action" title="Create a quest">
    <div className="form-stack">
      <Field label="Quest title"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Complete Spanish lesson 12" /></Field>
      <Field label="Notes" hint="Optional"><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does done look like?" /></Field>
      <div className="form-grid"><Field label="Due date"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field><Field label="Repeats"><select value={repeat} onChange={(e) => setRepeat(e.target.value as Quest["repeat"])}><option value="none">One-off</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></Field></div>
      <div className="form-grid thirds"><Field label="Effort"><select value={effort} onChange={(e) => setEffort(e.target.value as QuestEffort)}><option value="quick">Quick · 5</option><option value="standard">Standard · 15</option><option value="focused">Focused · 30</option><option value="major">Major · 50</option></select></Field><Field label="Difficulty"><select value={difficulty} onChange={(e) => setDifficulty(e.target.value as QuestDifficulty)}><option value="easy">Easy · +0</option><option value="moderate">Moderate · +5</option><option value="difficult">Difficult · +10</option></select></Field><Field label="Impact"><select value={impact} onChange={(e) => setImpact(e.target.value as QuestImpact)}><option value="supporting">Supporting · +0</option><option value="meaningful">Meaningful · +5</option><option value="important">Important · +10</option></select></Field></div>
      <Field label="Expected minutes" hint="Optional — time is context, not the progress score"><input type="number" min="0" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="45" /></Field>
      {goal?.metrics.length ? <div className="form-grid"><Field label="Update a metric" hint="Optional"><select value={metricId} onChange={(e) => setMetricId(e.target.value)}><option value="">No automatic update</option>{goal.metrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}</select></Field><Field label="Amount"><input type="number" value={metricAmount} disabled={!metricId} onChange={(e) => setMetricAmount(Number(e.target.value))} /></Field></div> : null}
      <div className="xp-preview"><span>Completion award</span><strong>{xp} XP</strong><small>{effort} effort + {difficulty} difficulty + {impact} impact</small></div>
      <div className="button-row end"><Button variant="ghost" onClick={close}>Cancel</Button><Button disabled={!title.trim()} onClick={submit}><Plus size={16} /> Add quest</Button></div>
    </div>
  </Modal>;
}
