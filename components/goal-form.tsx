"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Plus, Sparkles, Target } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, Field, Modal } from "@/components/ui";
import type { Goal, GoalModel, Priority } from "@/lib/types";
import { uid } from "@/lib/utils";

const models: { id: GoalModel; title: string; description: string; example: string }[] = [
  { id: "numeric", title: "Numeric", description: "A measurable target with one or more real values.", example: "£650 of £2,000 saved" },
  { id: "weighted", title: "Weighted milestones", description: "Meaningful stages contribute a defined share.", example: "Portfolio 30% · CV 20%" },
  { id: "consistency", title: "Consistency", description: "Track completion rate and total investment, not streaks.", example: "8 of 12 sessions this month" },
  { id: "open", title: "Open-ended", description: "Use evidence and written check-ins when a number would be misleading.", example: "Confidence · organisation · network" },
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
  const [statIds, setStatIds] = useState<string[]>(state.stats[0]?.id ? [state.stats[0].id] : []);
  const [questTitle, setQuestTitle] = useState("");
  const steps = ["Direction", "Measurement", "Qualities", "First action"];

  const canContinue = useMemo(() => {
    if (step === 0) return Boolean(title.trim() && description.trim() && areaId);
    if (step === 1 && (model === "numeric" || model === "consistency")) return Boolean(metricLabel.trim() && metricTarget > 0);
    if (step === 1 && model === "weighted") return milestoneText.split("\n").filter((line) => line.trim()).length > 0;
    if (step === 2) return statIds.length > 0 || state.stats.filter((stat) => !stat.archived).length === 0;
    return true;
  }, [areaId, description, metricLabel, metricTarget, milestoneText, model, statIds.length, state.stats, step, title]);

  const reset = () => {
    setStep(0); setTitle(""); setDescription(""); setPriority("medium"); setTargetDate(""); setModel("numeric");
    setMetricLabel("Progress"); setMetricCurrent(0); setMetricTarget(100); setMetricUnit(""); setMilestoneText("");
    setStatIds(state.stats[0]?.id ? [state.stats[0].id] : []); setQuestTitle("");
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
      milestones: lines.map((line) => ({ id: uid("milestone"), title: line, weight: model === "weighted" ? 100 / lines.length : 0, completed: false })),
      quests: questTitle.trim() ? [{ id: uid("quest"), title: questTitle.trim(), repeat: "none", completed: false, metricDeltas: [] }] : [],
      statIds,
      checkIns: [],
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
        <div className="form-intro"><span><Sparkles /></span><div><h3>Choose honest progress</h3><p>Use the model that best reflects the real-world outcome you care about.</p></div></div>
        <div className="model-grid">{models.map((item) => <button key={item.id} onClick={() => setModel(item.id)} className={model === item.id ? "model-card active" : "model-card"}><span className="choice-radio" /><strong>{item.title}</strong><p>{item.description}</p><small>{item.example}</small></button>)}</div>
        {(model === "numeric" || model === "consistency") && <div className="metric-builder"><div className="form-grid thirds"><Field label="What are you measuring?"><input value={metricLabel} onChange={(e) => setMetricLabel(e.target.value)} placeholder="Words learned" /></Field><Field label="Current"><input type="number" min="0" value={metricCurrent} onChange={(e) => setMetricCurrent(Number(e.target.value))} /></Field><Field label="Target"><input type="number" min="1" value={metricTarget} onChange={(e) => setMetricTarget(Number(e.target.value))} /></Field></div><Field label="Unit"><input value={metricUnit} onChange={(e) => setMetricUnit(e.target.value)} placeholder="words, £, sessions, lessons…" /></Field></div>}
        {model === "weighted" && <Field label="Milestones" hint="One milestone per line. We will split the weight evenly; you can fine-tune it later."><textarea rows={5} value={milestoneText} onChange={(e) => setMilestoneText(e.target.value)} placeholder={"Complete course material\nBuild portfolio project\nPrepare CV\nSubmit applications"} /></Field>}
        {model === "open" && <div className="setting-note"><Sparkles size={17} /><p>Open-ended goals use dated reflections and evidence instead of a made-up completion percentage. Add your first check-in from the goal page.</p></div>}
      </div>}

      {step === 2 && <div className="form-section">
        <div className="form-intro"><span><Sparkles /></span><div><h3>Connect the qualities you are developing</h3><p>Choose every quality this goal supports. These links organise your activity; they do not assign points.</p></div></div>
        <div className="quality-list">{state.stats.filter((stat) => !stat.archived).map((stat) => { const selected = statIds.includes(stat.id); return <button type="button" key={stat.id} className={selected ? "selected" : ""} aria-pressed={selected} onClick={() => setStatIds((current) => selected ? current.filter((id) => id !== stat.id) : [...current, stat.id])}><i style={{ background: stat.color }} /><span>{stat.name}</span>{selected && <Check size={15} />}</button>; })}</div>
        {!state.stats.some((stat) => !stat.archived) && <p className="muted-copy">You can create qualities later from Settings.</p>}
      </div>}

      {step === 3 && <div className="form-section">
        <div className="form-intro"><span><Check /></span><div><h3>Name the first useful action</h3><p>A goal should answer “what can I do next?” You can leave this blank and add quests later.</p></div></div>
        <Field label="First quest" hint="Optional"><input value={questTitle} onChange={(e) => setQuestTitle(e.target.value)} placeholder="Complete the first course lesson" /></Field>
        <div className="setting-note"><Check size={17} /><p>Completing an action records what happened and when. Your goal progress comes from its metrics, milestones, consistency, or reflections.</p></div>
      </div>}

      <footer className="wizard-footer"><Button variant="ghost" onClick={step === 0 ? close : () => setStep((current) => current - 1)}>{step === 0 ? "Cancel" : <><ArrowLeft size={16} /> Back</>}</Button>{step < steps.length - 1 ? <Button disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>Continue <ArrowRight size={16} /></Button> : <Button onClick={submit}><Plus size={16} /> Create goal</Button>}</footer>
    </Modal>
  );
}
