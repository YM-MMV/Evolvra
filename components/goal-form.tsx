"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Plus, Sparkles, Target } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, Field, Modal, ProgressBar } from "@/components/ui";
import type { Goal, GoalModel, Priority, QuestDifficulty, QuestEffort, QuestImpact } from "@/lib/types";
import { questXp, uid } from "@/lib/utils";

const models: { id: GoalModel; title: string; description: string; example: string }[] = [
  { id: "numeric", title: "Numeric", description: "A measurable target with one or more real values.", example: "£650 of £2,000 saved" },
  { id: "weighted", title: "Weighted milestones", description: "Meaningful stages contribute a defined share.", example: "Portfolio 30% · CV 20%" },
  { id: "consistency", title: "Consistency", description: "Track completion rate and total investment, not streaks.", example: "8 of 12 sessions this month" },
  { id: "open", title: "Open-ended", description: "Use evidence, check-ins, and self-assessment.", example: "Confidence · organisation · network" },
];

export function GoalForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, addGoal } = useApp();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [areaId, setAreaId] = useState(state.areas.find((area) => !area.archived)?.id ?? "");
  const [priority, setPriority] = useState<Priority>("medium");
  const [targetDate, setTargetDate] = useState("");
  const [model, setModel] = useState<GoalModel>("numeric");
  const [metricLabel, setMetricLabel] = useState("Progress");
  const [metricCurrent, setMetricCurrent] = useState(0);
  const [metricTarget, setMetricTarget] = useState(100);
  const [metricUnit, setMetricUnit] = useState("");
  const [milestoneText, setMilestoneText] = useState("");
  const [openScore, setOpenScore] = useState(0);
  const [weights, setWeights] = useState<Record<string, number>>({ [state.stats[0]?.id]: 100 });
  const [questTitle, setQuestTitle] = useState("");
  const [effort, setEffort] = useState<QuestEffort>("standard");
  const [difficulty, setDifficulty] = useState<QuestDifficulty>("moderate");
  const [impact, setImpact] = useState<QuestImpact>("meaningful");
  const weightTotal = Object.values(weights).reduce((sum, weight) => sum + Number(weight), 0);
  const xp = questXp({ effort, difficulty, impact }, state.settings.scoring);
  const steps = ["Direction", "Measurement", "Stats", "First action"];

  const canContinue = useMemo(() => {
    if (step === 0) return Boolean(title.trim() && description.trim() && areaId);
    if (step === 1 && (model === "numeric" || model === "consistency")) return Boolean(metricLabel.trim() && metricTarget > 0);
    if (step === 1 && model === "weighted") return milestoneText.split("\n").filter((line) => line.trim()).length > 0;
    if (step === 2) return weightTotal === 100;
    return true;
  }, [areaId, description, metricLabel, metricTarget, milestoneText, model, step, title, weightTotal]);

  const reset = () => {
    setStep(0); setTitle(""); setDescription(""); setPriority("medium"); setTargetDate(""); setModel("numeric");
    setMetricLabel("Progress"); setMetricCurrent(0); setMetricTarget(100); setMetricUnit(""); setMilestoneText("");
    setOpenScore(0); setWeights({ [state.stats[0]?.id]: 100 }); setQuestTitle(""); setEffort("standard");
    setDifficulty("moderate"); setImpact("meaningful");
  };

  const close = () => { reset(); onClose(); };

  const submit = () => {
    const metricId = uid("metric");
    const lines = milestoneText.split("\n").map((line) => line.trim()).filter(Boolean);
    const goal: Goal = {
      id: uid("goal"),
      title: title.trim(),
      description: description.trim(),
      areaId,
      model,
      priority,
      targetDate: targetDate || undefined,
      status: "active",
      createdAt: new Date().toISOString(),
      metrics: model === "numeric" || model === "consistency" ? [{ id: metricId, label: metricLabel.trim(), current: metricCurrent, target: metricTarget, unit: metricUnit.trim(), weight: 100 }] : [],
      milestones: lines.map((line, index) => ({ id: uid("milestone"), title: line, weight: model === "weighted" ? 100 / lines.length : 0, xp: index === lines.length - 1 ? 200 : 100, completed: false })),
      quests: questTitle.trim() ? [{ id: uid("quest"), title: questTitle.trim(), effort, difficulty, impact, xp, repeat: "none", completed: false, metricDeltas: [] }] : [],
      statWeights: Object.fromEntries(Object.entries(weights).filter(([, weight]) => Number(weight) > 0)),
      checkInScore: model === "open" ? openScore : undefined,
      evidence: [],
      notes: "",
    };
    addGoal(goal);
    close();
  };

  return (
    <Modal open={open} onClose={close} eyebrow="Goal architect" title="Create a meaningful goal" wide>
      <div className="wizard-progress">
        {steps.map((label, index) => <div key={label} className={index === step ? "active" : index < step ? "done" : ""}><span>{index < step ? <Check size={13} /> : index + 1}</span><small>{label}</small></div>)}
      </div>

      {step === 0 && <div className="form-section">
        <div className="form-intro"><span><Target /></span><div><h3>Define the outcome</h3><p>Describe what will be different when this goal has genuinely moved forward.</p></div></div>
        <Field label="Goal title"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Reach conversational Spanish" /></Field>
        <Field label="Why this matters"><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="I want to speak comfortably when travelling…" /></Field>
        <div className="form-grid thirds"><Field label="Life area"><select value={areaId} onChange={(e) => setAreaId(e.target.value)}>{state.areas.filter((area) => !area.archived).map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></Field><Field label="Importance"><select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></Field><Field label="Target date" hint="Optional"><input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></Field></div>
      </div>}

      {step === 1 && <div className="form-section">
        <div className="form-intro"><span><Sparkles /></span><div><h3>Choose honest progress</h3><p>XP measures effort. This model measures the real-world outcome separately.</p></div></div>
        <div className="model-grid">{models.map((item) => <button key={item.id} onClick={() => setModel(item.id)} className={model === item.id ? "model-card active" : "model-card"}><span className="choice-radio" /><strong>{item.title}</strong><p>{item.description}</p><small>{item.example}</small></button>)}</div>
        {(model === "numeric" || model === "consistency") && <div className="metric-builder"><div className="form-grid thirds"><Field label="What are you measuring?"><input value={metricLabel} onChange={(e) => setMetricLabel(e.target.value)} placeholder="Words learned" /></Field><Field label="Current"><input type="number" min="0" value={metricCurrent} onChange={(e) => setMetricCurrent(Number(e.target.value))} /></Field><Field label="Target"><input type="number" min="1" value={metricTarget} onChange={(e) => setMetricTarget(Number(e.target.value))} /></Field></div><Field label="Unit"><input value={metricUnit} onChange={(e) => setMetricUnit(e.target.value)} placeholder="words, £, sessions, lessons…" /></Field></div>}
        {model === "weighted" && <Field label="Milestones" hint="One milestone per line. We will split the weight evenly; you can fine-tune it later."><textarea rows={5} value={milestoneText} onChange={(e) => setMilestoneText(e.target.value)} placeholder={"Complete course material\nBuild portfolio project\nPrepare CV\nSubmit applications"} /></Field>}
        {model === "open" && <Field label="Current self-assessment" hint="This is a check-in, not a fake completion percentage."><div className="range-field"><input type="range" min="0" max="100" value={openScore} onChange={(e) => setOpenScore(Number(e.target.value))} /><strong>{openScore}/100</strong></div></Field>}
      </div>}

      {step === 2 && <div className="form-section">
        <div className="form-intro"><span><Sparkles /></span><div><h3>Connect character growth</h3><p>Allocate exactly 100%. XP earned through this goal will be shared across these stats.</p></div></div>
        <div className="weight-total"><div><span>Allocated</span><strong className={weightTotal === 100 ? "valid" : ""}>{weightTotal}%</strong></div><ProgressBar value={weightTotal} color={weightTotal === 100 ? "var(--positive)" : "var(--accent)"} /></div>
        <div className="weight-list">{state.stats.filter((stat) => !stat.archived).map((stat) => <label key={stat.id}><span><i style={{ background: stat.color }} />{stat.name}</span><div><input type="number" min="0" max="100" value={weights[stat.id] ?? 0} onChange={(e) => setWeights((current) => ({ ...current, [stat.id]: Number(e.target.value) }))} /><small>%</small></div></label>)}</div>
      </div>}

      {step === 3 && <div className="form-section">
        <div className="form-intro"><span><Check /></span><div><h3>Name the first useful action</h3><p>A goal should answer “what can I do next?” You can leave this blank and add quests later.</p></div></div>
        <Field label="First quest" hint="Optional"><input value={questTitle} onChange={(e) => setQuestTitle(e.target.value)} placeholder="Complete the first course lesson" /></Field>
        <div className="form-grid thirds"><Field label="Effort"><select value={effort} onChange={(e) => setEffort(e.target.value as QuestEffort)}><option value="quick">Quick · 5</option><option value="standard">Standard · 15</option><option value="focused">Focused · 30</option><option value="major">Major · 50</option></select></Field><Field label="Difficulty"><select value={difficulty} onChange={(e) => setDifficulty(e.target.value as QuestDifficulty)}><option value="easy">Easy · +0</option><option value="moderate">Moderate · +5</option><option value="difficult">Difficult · +10</option></select></Field><Field label="Impact"><select value={impact} onChange={(e) => setImpact(e.target.value as QuestImpact)}><option value="supporting">Supporting · +0</option><option value="meaningful">Meaningful · +5</option><option value="important">Important · +10</option></select></Field></div>
        <div className="xp-preview"><span>Quest score</span><strong>{xp} XP</strong><small>Editable inputs · capped at {state.settings.scoring.questCap} XP</small></div>
      </div>}

      <footer className="wizard-footer"><Button variant="ghost" onClick={step === 0 ? close : () => setStep((current) => current - 1)}>{step === 0 ? "Cancel" : <><ArrowLeft size={16} /> Back</>}</Button>{step < steps.length - 1 ? <Button disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>Continue <ArrowRight size={16} /></Button> : <Button onClick={submit}><Plus size={16} /> Create goal</Button>}</footer>
    </Modal>
  );
}
