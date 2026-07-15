"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays, Check, Circle, FileText, Flag, MoreHorizontal, Pause, Play, Plus, Save, Sparkles, Target, Trash2, Trophy } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { DynamicIcon } from "@/components/icons";
import { QuestForm } from "@/components/quest-form";
import { Button, EmptyState, Field, Modal, Panel, Pill, ProgressBar } from "@/components/ui";
import type { Milestone } from "@/lib/types";
import { formatDate, getArea, goalProgress, levelFromXp, uid } from "@/lib/utils";

export default function GoalDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { state, updateGoal, setGoalStatus, deleteGoal, completeQuest, toggleMilestone, updateMetric } = useApp();
  const goal = state.goals.find((item) => item.id === params.id);
  const [questOpen, setQuestOpen] = useState(false);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneWeight, setMilestoneWeight] = useState(10);
  const [milestoneXp, setMilestoneXp] = useState(100);
  const [notes, setNotes] = useState(goal?.notes ?? "");
  const [evidence, setEvidence] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const evidenceInput = useRef<HTMLInputElement>(null);

  if (!goal) return <EmptyState icon={<Target />} title="Goal not found" body="It may have been removed or is no longer available on this device." action={<Link href="/goals" className="button button-secondary">Back to goals</Link>} />;

  const area = getArea(state, goal.areaId);
  const progress = goalProgress(goal);
  const activity = state.timeline.filter((event) => event.goalId === goal.id).slice(0, 12);
  const completedQuests = goal.quests.filter((quest) => quest.completed).length;
  const totalWeight = goal.milestones.reduce((sum, milestone) => sum + milestone.weight, 0);

  const addMilestone = () => {
    if (!milestoneTitle.trim()) return;
    const milestone: Milestone = { id: uid("milestone"), title: milestoneTitle.trim(), weight: milestoneWeight, xp: milestoneXp, completed: false };
    updateGoal(goal.id, { milestones: [...goal.milestones, milestone] });
    setMilestoneOpen(false); setMilestoneTitle(""); setMilestoneWeight(10); setMilestoneXp(100);
  };

  const addEvidenceFile = (file?: File) => {
    if (!file) return;
    if (file.size > 1_000_000) {
      window.alert("For local evidence, choose a file under 1 MB. Larger private uploads are available after Supabase storage is connected.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => updateGoal(goal.id, { evidence: [...goal.evidence, `file|${file.name}|${String(reader.result)}`] });
    reader.readAsDataURL(file);
  };

  return <div className="goal-detail">
    <Link href="/goals" className="back-link"><ArrowLeft size={16} /> All goals</Link>
    <section className="goal-detail-hero panel" style={{ "--goal-color": area?.color } as React.CSSProperties}>
      <div className="goal-hero-main">
        <span className="goal-hero-icon" style={{ color: area?.color, background: `${area?.color}18` }}><DynamicIcon name={area?.icon ?? "Target"} size={25} /></span>
        <div><div className="goal-kicker"><span style={{ color: area?.color }}>{area?.name}</span><Pill>{goal.model}</Pill><Pill>{goal.status}</Pill></div><h1>{goal.title}</h1><p>{goal.description}</p><div className="goal-hero-meta"><span><Flag size={14} /> {goal.priority} importance</span>{goal.targetDate && <span><CalendarDays size={14} /> Target {formatDate(goal.targetDate)}</span>}<span>Created {formatDate(goal.createdAt)}</span></div></div>
      </div>
      <div className="goal-hero-actions">
        {goal.status === "active" ? <Button variant="secondary" onClick={() => setGoalStatus(goal.id, "paused")}><Pause size={16} /> Pause</Button> : goal.status === "paused" ? <Button variant="secondary" onClick={() => setGoalStatus(goal.id, "active")}><Play size={16} /> Resume</Button> : null}
        {goal.status !== "completed" && <Button onClick={() => setGoalStatus(goal.id, "completed")}><Trophy size={16} /> Complete goal</Button>}
        <div className="menu-wrap"><button className="icon-button" aria-label="More goal actions" onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={20} /></button>{menuOpen && <div className="popover-menu"><button onClick={() => setGoalStatus(goal.id, "archived")}><FileText size={15} /> Archive</button><button className="danger" onClick={() => { if (window.confirm("Remove this goal? Earned XP will remain.")) { deleteGoal(goal.id); router.push("/goals"); } }}><Trash2 size={15} /> Remove</button></div>}</div>
      </div>
      <div className="goal-hero-progress">
        <div><span>{progress === null ? "Reflective check-in" : "Overall progress"}</span><strong>{progress === null ? "Open" : `${Math.round(progress)}%`}</strong></div>
        {progress === null ? <div className="range-field open-score"><input type="range" min="0" max="100" value={goal.checkInScore ?? 0} onChange={(e) => updateGoal(goal.id, { checkInScore: Number(e.target.value) })} /><span>{goal.checkInScore ?? 0}/100 current self-assessment</span></div> : <ProgressBar value={progress} color={area?.color} />}
      </div>
    </section>

    <div className="goal-detail-grid">
      <div className="goal-detail-main">
        <Panel>
          <div className="section-heading"><div><p className="eyebrow">Real-world measurement</p><h2>Progress metrics</h2></div></div>
          {goal.metrics.length ? <div className="metric-list">{goal.metrics.map((metric) => { const value = metric.target ? Math.min(100, (metric.current / metric.target) * 100) : 0; return <div key={metric.id} className="metric-row"><div><span>{metric.label}</span><strong>{metric.unit === "£" && "£"}{metric.current.toLocaleString()} <small>/ {metric.unit === "£" && "£"}{metric.target.toLocaleString()} {metric.unit !== "£" && metric.unit}</small></strong></div><ProgressBar value={value} color={area?.color} /><Field label="Current value"><input type="number" min="0" value={metric.current} onChange={(e) => updateMetric(goal.id, metric.id, Number(e.target.value))} /></Field></div>; })}</div> : <div className="reflection-card"><Sparkles /><div><strong>Progress is reflective</strong><p>This goal uses check-ins, evidence, and milestones instead of pretending every outcome has a precise percentage.</p></div></div>}
        </Panel>

        <Panel>
          <div className="section-heading"><div><p className="eyebrow">Meaningful stages</p><h2>Milestone path</h2></div><Button variant="secondary" onClick={() => setMilestoneOpen(true)}><Plus size={15} /> Add</Button></div>
          {goal.model === "weighted" && <div className={`weight-notice ${Math.round(totalWeight) === 100 ? "valid" : ""}`}><span>Milestone weight</span><strong>{Math.round(totalWeight)}%</strong><small>{Math.round(totalWeight) === 100 ? "Balanced" : "Adjust milestones to total 100%"}</small></div>}
          <div className="milestone-list">{goal.milestones.map((milestone, index) => <button key={milestone.id} className={milestone.completed ? "completed" : ""} onClick={() => toggleMilestone(goal.id, milestone.id)}><span className="milestone-line" /><span className="milestone-check">{milestone.completed ? <Check size={16} /> : <Circle size={16} />}</span><div><small>Stage {index + 1}{goal.model === "weighted" ? ` · ${Math.round(milestone.weight)}%` : ""}</small><strong>{milestone.title}</strong><span>{milestone.xp} XP</span></div></button>)}</div>
          {!goal.milestones.length && <EmptyState icon={<Target />} title="No milestones yet" body="Split this goal into stages that would feel meaningfully different." />}
        </Panel>

        <Panel>
          <div className="section-heading"><div><p className="eyebrow">Actions that move it</p><h2>Quest board</h2></div><Button onClick={() => setQuestOpen(true)}><Plus size={15} /> Add quest</Button></div>
          <div className="quest-list">{goal.quests.map((quest) => <div key={quest.id} className={quest.completed ? "quest-row completed" : "quest-row"}><button className="quest-check" aria-label={quest.completed ? `${quest.title} completed` : `Complete ${quest.title}`} onClick={() => completeQuest(goal.id, quest.id)} disabled={quest.completed}>{quest.completed ? <Check size={16} /> : <Circle size={17} />}</button><div><strong>{quest.title}</strong><span>{quest.description || `${quest.effort} · ${quest.difficulty} · ${quest.impact}`}</span></div><div className="quest-row-meta">{quest.repeat !== "none" && <Pill>{quest.repeat}</Pill>}<strong>+{quest.xp} XP</strong></div></div>)}</div>
          {!goal.quests.length && <EmptyState icon={<Check />} title="No next action yet" body="Add the smallest useful action that would create genuine movement." />}
        </Panel>

        <Panel>
          <div className="section-heading"><div><p className="eyebrow">Context and proof</p><h2>Notes & evidence</h2></div></div>
          <Field label="Working notes"><textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => updateGoal(goal.id, { notes })} placeholder="What are you learning about this goal?" /></Field>
          <div className="evidence-add"><input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Add an evidence link or short note" /><Button variant="secondary" disabled={!evidence.trim()} onClick={() => { updateGoal(goal.id, { evidence: [...goal.evidence, evidence.trim()] }); setEvidence(""); }}><Plus size={15} /> Add</Button><Button variant="secondary" onClick={() => evidenceInput.current?.click()}><FileText size={15} /> Upload file</Button><input ref={evidenceInput} hidden type="file" accept="image/png,image/jpeg,image/webp,application/pdf,text/plain" onChange={(event) => { addEvidenceFile(event.target.files?.[0]); event.target.value = ""; }} /></div>
          <div className="evidence-list">{goal.evidence.map((item, index) => { const [kind, name, data] = item.split("|"); return <div key={`${item}-${index}`}><FileText size={15} />{kind === "file" ? <a href={data} download={name}>{name}</a> : <span>{item}</span>}</div>; })}</div>
        </Panel>
      </div>

      <aside className="goal-detail-rail">
        <Panel><div className="section-heading compact"><div><p className="eyebrow">Character impact</p><h2>Connected stats</h2></div></div><div className="connected-stats">{Object.entries(goal.statWeights).map(([statId, weight]) => { const stat = state.stats.find((item) => item.id === statId); if (!stat) return null; const level = levelFromXp(stat.xp, state.settings.scoring.levelBase, state.settings.scoring.levelGrowth); return <div key={statId}><span style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} size={17} /></span><div><strong>{stat.name}</strong><small>Level {level.level}</small></div><b>{weight}%</b></div>; })}</div></Panel>
        <Panel><div className="section-heading compact"><div><p className="eyebrow">At a glance</p><h2>Goal record</h2></div></div><div className="record-grid"><div><strong>{completedQuests}</strong><span>quests completed</span></div><div><strong>{goal.milestones.filter((item) => item.completed).length}/{goal.milestones.length}</strong><span>milestones reached</span></div><div><strong>{goal.quests.filter((item) => item.completed).reduce((sum, item) => sum + item.xp, 0)}</strong><span>quest XP earned</span></div><div><strong>{activity.length}</strong><span>recorded events</span></div></div></Panel>
        <Panel><div className="section-heading compact"><div><p className="eyebrow">History</p><h2>Recent movement</h2></div></div><div className="activity-list">{activity.map((event) => <div key={event.id}><span className={`event-dot type-${event.type}`} /><div><strong>{event.title}</strong><small>{formatDate(event.at)}</small></div>{event.xp && <b>+{event.xp}</b>}</div>)}{!activity.length && <p className="muted-copy">Activity will appear as you progress this goal.</p>}</div></Panel>
      </aside>
    </div>

    <QuestForm goalId={goal.id} open={questOpen} onClose={() => setQuestOpen(false)} />
    <Modal open={milestoneOpen} onClose={() => setMilestoneOpen(false)} title="Add a milestone" eyebrow="Meaningful stage"><div className="form-stack"><Field label="Milestone"><input autoFocus value={milestoneTitle} onChange={(e) => setMilestoneTitle(e.target.value)} placeholder="Pass the A2 assessment" /></Field><div className="form-grid"><Field label="Goal weight"><input type="number" min="0" max="100" value={milestoneWeight} onChange={(e) => setMilestoneWeight(Number(e.target.value))} /></Field><Field label="XP award"><select value={milestoneXp} onChange={(e) => setMilestoneXp(Number(e.target.value))}><option value="50">Small · 50</option><option value="100">Standard · 100</option><option value="200">Major · 200</option><option value="300">Goal-defining · 300</option></select></Field></div><div className="button-row end"><Button variant="ghost" onClick={() => setMilestoneOpen(false)}>Cancel</Button><Button onClick={addMilestone}><Save size={16} /> Save milestone</Button></div></div></Modal>
  </div>;
}
