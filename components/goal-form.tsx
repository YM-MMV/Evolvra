"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Plus, Sparkles, Target, Trash2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, Field, FieldGroup, Modal } from "@/components/ui";
import { WORKSPACE_TEXT_LIMITS } from "@/lib/state-schema";
import type { ConsistencyPeriod, Goal, GoalModel, Priority } from "@/lib/types";
import { activePeriodKey, isFiniteWorkspaceNumber, MAX_WORKSPACE_NUMBER, singularizeTerm, uid } from "@/lib/utils";

const models: { id: GoalModel; title: string; description: string; example: string }[] = [
  { id: "numeric", title: "Numeric", description: "A measurable target with one or more real values.", example: "£650 of £2,000 saved" },
  { id: "weighted", title: "Weighted milestones", description: "Meaningful stages contribute a defined share.", example: "Portfolio 30% · CV 20%" },
  { id: "consistency", title: "Consistency", description: "Track completion rate and total investment over a chosen period.", example: "8 of 12 sessions this month" },
  { id: "open", title: "Open-ended", description: "Use evidence and written check-ins when a number would be misleading.", example: "Confidence · organisation · network" },
];

const templates: Array<{
  title: string;
  description: string;
  model: GoalModel;
  metricLabel?: string;
  metricTarget?: number;
  metricUnit?: string;
  milestones?: string;
  firstAction: string;
}> = [
  { title: "Develop a regular practice", description: "Build a sustainable rhythm around something that matters.", model: "consistency", metricLabel: "Sessions this month", metricTarget: 12, metricUnit: "sessions", firstAction: "Schedule the first session" },
  { title: "Complete a meaningful project", description: "Move a defined project from idea to a finished, useful result.", model: "weighted", milestones: "Define the outcome\nCreate the first complete version\nTest and revise\nShare or deliver the result", firstAction: "Write the project brief" },
  { title: "Explore a new direction", description: "Use written check-ins and evidence to learn before forcing a numeric target.", model: "open", firstAction: "Record what I already know" },
];

interface DraftMetric {
  id: string;
  label: string;
  current: number;
  target: number;
  unit: string;
  weight: number;
  period: ConsistencyPeriod;
}

const newDraftMetric = (overrides: Partial<DraftMetric> = {}): DraftMetric => ({
  id: uid("metric"),
  label: "Progress",
  current: 0,
  target: 100,
  unit: "",
  weight: 100,
  period: "month",
  ...overrides,
});

export function GoalForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, addGoal } = useApp();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [areaId, setAreaId] = useState(state.areas.find((area) => !area.archived && !area.hidden)?.id ?? "");
  const [priority, setPriority] = useState<Priority>("medium");
  const [targetDate, setTargetDate] = useState("");
  const [model, setModel] = useState<GoalModel>("numeric");
  const [metrics, setMetrics] = useState<DraftMetric[]>(() => [newDraftMetric()]);
  const [milestoneText, setMilestoneText] = useState("");
  const [statIds, setStatIds] = useState<string[]>(() => {
    const firstAvailable = state.stats.find((stat) => !stat.archived);
    return firstAvailable ? [firstAvailable.id] : [];
  });
  const [questTitle, setQuestTitle] = useState("");
  const terms = state.settings.terminology;
  const goalTerm = singularizeTerm(terms.goals);
  const questTerm = singularizeTerm(terms.quests);
  const areaTerm = singularizeTerm(terms.areas);
  const milestoneTerm = singularizeTerm(terms.milestones);
  const steps = ["Direction", "Measurement", "Qualities", "First action"];
  const metricsValid = metrics.length > 0
    && metrics.every((metric) => metric.label.trim()
      && isFiniteWorkspaceNumber(metric.current, 0)
      && isFiniteWorkspaceNumber(metric.target, Number.MIN_VALUE)
      && isFiniteWorkspaceNumber(metric.weight, 0, 100))
    && metrics.some((metric) => metric.weight > 0);

  const canContinue = useMemo(() => {
    if (step === 0) return Boolean(title.trim() && description.trim() && areaId);
    if (step === 1 && (model === "numeric" || model === "consistency")) return metricsValid;
    if (step === 1 && model === "weighted") return milestoneText.split("\n").filter((line) => line.trim()).length > 0;
    if (step === 2) return statIds.length > 0 || state.stats.filter((stat) => !stat.archived).length === 0;
    return true;
  }, [areaId, description, metricsValid, milestoneText, model, statIds.length, state.stats, step, title]);

  const reset = () => {
    setStep(0); setTitle(""); setDescription(""); setPriority("medium"); setTargetDate(""); setModel("numeric");
    setMetrics([newDraftMetric()]); setMilestoneText("");
    const firstAvailable = state.stats.find((stat) => !stat.archived);
    setStatIds(firstAvailable ? [firstAvailable.id] : []); setQuestTitle("");
  };

  const close = () => { reset(); onClose(); };

  const applyTemplate = (template: (typeof templates)[number]) => {
    setTitle(template.title);
    setDescription(template.description);
    setModel(template.model);
    setMetrics([newDraftMetric({
      label: template.metricLabel ?? "Progress",
      target: template.metricTarget ?? 100,
      unit: template.metricUnit ?? "",
    })]);
    setMilestoneText(template.milestones ?? "");
    setQuestTitle(template.firstAction);
  };

  const submit = () => {
    if ((model === "numeric" || model === "consistency") && !metricsValid) return;
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
      metrics: model === "numeric" || model === "consistency" ? metrics.map((metric) => ({
        id: metric.id,
        label: metric.label.trim(),
        current: metric.current,
        target: metric.target,
        unit: metric.unit.trim(),
        weight: metric.weight,
        ...(model === "consistency" ? { period: metric.period, periodKey: activePeriodKey(metric.period) } : {}),
      })) : [],
      milestones: lines.map((line) => ({ id: uid("milestone"), title: line, weight: model === "weighted" ? 100 / lines.length : 0, completed: false })),
      quests: questTitle.trim() ? [{ id: uid("quest"), kind: "task", linkedGoalIds: [], title: questTitle.trim(), repeat: "none", completed: false, metricDeltas: [] }] : [],
      statIds,
      checkIns: [],
      evidence: [],
      notes: "",
    };
    addGoal(goal);
    close();
  };

  return (
    <Modal open={open} onClose={close} eyebrow={`${goalTerm} architect`} title={`Create a meaningful ${goalTerm.toLowerCase()}`} wide>
      <div className="wizard-progress">
        {steps.map((label, index) => <div key={label} className={index === step ? "active" : index < step ? "done" : ""}><span>{index < step ? <Check size={13} /> : index + 1}</span><small>{label}</small></div>)}
      </div>

      {step === 0 && <div className="form-section">
        <div className="form-intro"><span><Target /></span><div><h3>Define the outcome</h3><p>Describe what will be different when this {goalTerm.toLowerCase()} has genuinely moved forward.</p></div></div>
        <FieldGroup label="Start from a template" hint="Optional — every field remains editable."><div className="model-grid">{templates.map((template) => <button type="button" className="model-card" key={template.title} onClick={() => applyTemplate(template)}><strong>{template.title}</strong><p>{template.description}</p></button>)}</div></FieldGroup>
        <Field label={`${goalTerm} title`}><input data-modal-autofocus="true" maxLength={WORKSPACE_TEXT_LIMITS.goalTitle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Reach conversational Spanish" /></Field>
        <Field label="Why this matters"><textarea rows={3} maxLength={WORKSPACE_TEXT_LIMITS.goalDescription} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="I want to speak comfortably when travelling…" /></Field>
        <div className="form-grid thirds"><Field label={`Life ${areaTerm.toLowerCase()}`}><select value={areaId} onChange={(e) => setAreaId(e.target.value)}>{state.areas.filter((area) => !area.archived && !area.hidden).map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></Field><Field label="Importance"><select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></Field><Field label="Target date" hint="Optional"><input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></Field></div>
      </div>}

      {step === 1 && <div className="form-section">
        <div className="form-intro"><span><Sparkles /></span><div><h3>Choose honest progress</h3><p>Use the model that best reflects the real-world outcome you care about.</p></div></div>
        <div className="model-grid">{models.map((item) => <button key={item.id} onClick={() => setModel(item.id)} className={model === item.id ? "model-card active" : "model-card"}><span className="choice-radio" /><strong>{item.id === "weighted" ? `Weighted ${terms.milestones.toLowerCase()}` : item.title}</strong><p>{item.description}</p><small>{item.example}</small></button>)}</div>
        {(model === "numeric" || model === "consistency") && <div className="metric-builder">
          <div className="section-heading compact"><div><strong>Measurements</strong><p className="muted-copy">Add one or more outcomes and give each a relative weight. At least one weight must be above zero.</p></div><Button variant="secondary" onClick={() => setMetrics((current) => [...current, newDraftMetric({ label: `Measurement ${current.length + 1}` })])}><Plus size={15} /> Add measurement</Button></div>
          {metrics.map((metric, index) => <div className="metric-row" key={metric.id}>
            <div className="form-grid thirds"><Field label="What are you measuring?"><input maxLength={WORKSPACE_TEXT_LIMITS.metricLabel} value={metric.label} onChange={(event) => setMetrics((current) => current.map((item) => item.id === metric.id ? { ...item, label: event.target.value } : item))} placeholder="Words learned" /></Field><Field label="Current"><input type="number" min="0" max={MAX_WORKSPACE_NUMBER} value={metric.current} onChange={(event) => { const next = Number(event.target.value); setMetrics((current) => current.map((item) => item.id === metric.id ? { ...item, current: isFiniteWorkspaceNumber(next, 0) ? next : 0 } : item)); }} /></Field><Field label="Target"><input type="number" min="0.0000000001" max={MAX_WORKSPACE_NUMBER} value={metric.target} onChange={(event) => { const next = Number(event.target.value); setMetrics((current) => current.map((item) => item.id === metric.id ? { ...item, target: isFiniteWorkspaceNumber(next, Number.MIN_VALUE) ? next : 0 } : item)); }} /></Field></div>
            <div className="form-grid thirds"><Field label="Unit"><input maxLength={WORKSPACE_TEXT_LIMITS.metricUnit} value={metric.unit} onChange={(event) => setMetrics((current) => current.map((item) => item.id === metric.id ? { ...item, unit: event.target.value } : item))} placeholder="words, £, sessions, lessons…" /></Field><Field label="Relative weight"><input type="number" min="0" max="100" value={metric.weight} onChange={(event) => { const next = Number(event.target.value); setMetrics((current) => current.map((item) => item.id === metric.id ? { ...item, weight: isFiniteWorkspaceNumber(next, 0, 100) ? next : 0 } : item)); }} /></Field>{model === "consistency" && <Field label="Reset this count every"><select value={metric.period} onChange={(event) => setMetrics((current) => current.map((item) => item.id === metric.id ? { ...item, period: event.target.value as ConsistencyPeriod } : item))}><option value="week">Week</option><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option></select></Field>}</div>
            <div className="item-actions"><button type="button" aria-label={`Move ${metric.label || `measurement ${index + 1}`} up`} disabled={index === 0} onClick={() => setMetrics((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}><ArrowUp size={14} /></button><button type="button" aria-label={`Move ${metric.label || `measurement ${index + 1}`} down`} disabled={index === metrics.length - 1} onClick={() => setMetrics((current) => { const next = [...current]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next; })}><ArrowDown size={14} /></button><button type="button" className="danger" aria-label={`Remove ${metric.label || `measurement ${index + 1}`}`} disabled={metrics.length === 1} onClick={() => setMetrics((current) => current.filter((item) => item.id !== metric.id))}><Trash2 size={14} /></button></div>
          </div>)}
          {model === "consistency" && <p className="muted-copy">Each count starts fresh in its selected calendar period, so older activity never inflates the current view.</p>}
        </div>}
        {model === "weighted" && <Field label={terms.milestones} hint={`One ${milestoneTerm.toLowerCase()} per line. We will split the weight evenly; you can fine-tune it later.`}><textarea rows={5} value={milestoneText} onChange={(e) => setMilestoneText(e.target.value.split("\n").slice(0, 100).map((line) => line.slice(0, WORKSPACE_TEXT_LIMITS.milestoneTitle)).join("\n"))} placeholder={"Complete course material\nBuild portfolio project\nPrepare CV\nSubmit applications"} /></Field>}
        {model === "open" && <div className="setting-note"><Sparkles size={17} /><p>Open-ended {terms.goals.toLowerCase()} use dated reflections and evidence instead of a made-up completion percentage. Add your first check-in from the {goalTerm.toLowerCase()} page.</p></div>}
      </div>}

      {step === 2 && <div className="form-section">
        <div className="form-intro"><span><Sparkles /></span><div><h3>Connect the qualities you are developing</h3><p>Choose every quality this {goalTerm.toLowerCase()} supports. These links organise related activity and history.</p></div></div>
        <div className="quality-list">{state.stats.filter((stat) => !stat.archived).map((stat) => { const selected = statIds.includes(stat.id); return <button type="button" key={stat.id} className={selected ? "selected" : ""} aria-pressed={selected} onClick={() => setStatIds((current) => selected ? current.filter((id) => id !== stat.id) : [...current, stat.id])}><i style={{ background: stat.color }} /><span>{stat.name}</span>{selected && <Check size={15} />}</button>; })}</div>
        {!state.stats.some((stat) => !stat.archived) && <p className="muted-copy">You can create qualities later from Settings.</p>}
      </div>}

      {step === 3 && <div className="form-section">
        <div className="form-intro"><span><Check /></span><div><h3>Name the first useful action</h3><p>A {goalTerm.toLowerCase()} should answer “what can I do next?” You can leave this blank and add {terms.quests.toLowerCase()} later.</p></div></div>
        <Field label={`First ${questTerm.toLowerCase()}`} hint="Optional"><input maxLength={WORKSPACE_TEXT_LIMITS.actionTitle} value={questTitle} onChange={(e) => setQuestTitle(e.target.value)} placeholder="Complete the first course lesson" /></Field>
        <div className="setting-note"><Check size={17} /><p>Completing an action records what happened and when. Your {goalTerm.toLowerCase()} progress comes from its metrics, {terms.milestones.toLowerCase()}, consistency, or reflections.</p></div>
      </div>}

      <footer className="wizard-footer"><Button variant="ghost" onClick={step === 0 ? close : () => setStep((current) => current - 1)}>{step === 0 ? "Cancel" : <><ArrowLeft size={16} /> Back</>}</Button>{step < steps.length - 1 ? <Button disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>Continue <ArrowRight size={16} /></Button> : <Button onClick={submit}><Plus size={16} /> Create {goalTerm.toLowerCase()}</Button>}</footer>
    </Modal>
  );
}
