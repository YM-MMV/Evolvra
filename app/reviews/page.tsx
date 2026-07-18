"use client";

import { useMemo, useState } from "react";
import { BookOpenCheck, CalendarCheck, Check, ChevronDown, Clock3, Sparkles } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, EmptyState, Field, Panel } from "@/components/ui";
import type { ReviewCadence } from "@/lib/types";
import { formatDate, uid } from "@/lib/utils";

const prompts: Record<ReviewCadence, { key: string; label: string; placeholder: string }[]> = {
  daily: [
    { key: "worked", label: "What did I work on?", placeholder: "The actions, sessions, or decisions that received attention…" },
    { key: "progressed", label: "What genuinely progressed?", placeholder: "A measurement, understanding, milestone, or relationship that changed…" },
    { key: "blocked", label: "Is anything blocking me?", placeholder: "Name friction without judging yourself…" },
    { key: "next", label: "What should I focus on next?", placeholder: "One useful next action is enough…" },
  ],
  weekly: [
    { key: "movement", label: "Where did my goals move?", placeholder: "Notice real movement and quiet maintenance…" },
    { key: "developed", label: "Which qualities did I develop?", placeholder: "Knowledge, discipline, health, communication…" },
    { key: "achievement", label: "What was most meaningful?", placeholder: "It does not need to be the biggest event…" },
    { key: "adjust", label: "What needs adjustment?", placeholder: "Pause, resize, simplify, or re-sequence anything…" },
    { key: "priorities", label: "What deserves priority next week?", placeholder: "Choose direction without overloading the week…" },
  ],
  monthly: [
    { key: "progress", label: "What major progress became visible?", placeholder: "Look across goals, areas, and everyday life…" },
    { key: "milestones", label: "Which stages or achievements mattered?", placeholder: "Milestones, decisions, habits, and evidence…" },
    { key: "growth", label: "How did I develop?", placeholder: "What can you do, understand, or handle now?" },
    { key: "patterns", label: "What long-term patterns do I notice?", placeholder: "Energy, focus, environment, trade-offs…" },
    { key: "direction", label: "What direction feels right now?", placeholder: "Continue, change, pause, or begin…" },
  ],
};

export default function ReviewsPage() {
  const { state, addReview } = useApp();
  const [cadence, setCadence] = useState<ReviewCadence>("weekly");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const summary = useMemo(() => {
    const lastSeven = new Date();
    lastSeven.setDate(lastSeven.getDate() - 7);
    const weeklyEvents = state.timeline.filter((event) => new Date(event.at) >= lastSeven);
    return {
      activeDays: new Set(weeklyEvents.map((event) => new Date(event.at).toLocaleDateString("en-CA"))).size,
      quests: weeklyEvents.filter((event) => event.type === "quest").length,
      milestones: weeklyEvents.filter((event) => event.type === "milestone").length,
      activeGoals: state.goals.filter((goal) => goal.status === "active").length,
    };
  }, [state.goals, state.timeline]);

  const submit = () => {
    addReview({ id: uid("review"), cadence, createdAt: new Date().toISOString(), answers });
    setAnswers({}); setSaved(true); window.setTimeout(() => setSaved(false), 2500);
  };
  const filled = prompts[cadence].filter((prompt) => answers[prompt.key]?.trim()).length;

  return <div>
    <section className="page-header"><div><p className="eyebrow">Reflection without judgement</p><h1>Reviews</h1><p className="page-lead">Turn activity into understanding. Adjust your system without treating a quiet period as failure.</p></div></section>
    <div className="review-summary-grid">{[{ label: "Active days this week", value: summary.activeDays }, { label: "Quests completed", value: summary.quests }, { label: "Milestones reached", value: summary.milestones }, { label: "Active goals", value: summary.activeGoals }].map((item) => <Panel key={item.label}><strong>{item.value}</strong><span>{item.label}</span></Panel>)}</div>
    <div className="review-layout">
      <Panel className="review-form-panel">
        <div className="review-form-head"><div><p className="eyebrow">Guided reflection</p><h2>{cadence[0].toUpperCase() + cadence.slice(1)} review</h2></div><div className="cadence-switch">{(["daily", "weekly", "monthly"] as ReviewCadence[]).map((item) => <button key={item} className={cadence === item ? "active" : ""} onClick={() => { setCadence(item); setAnswers({}); }}>{item}</button>)}</div></div>
        <div className="reflection-banner"><Sparkles size={18} /><p>There are no perfect answers here. Notice what is true, useful, and kind enough to act on.</p></div>
        <div className="review-prompts">{prompts[cadence].map((prompt, index) => <Field key={prompt.key} label={`${index + 1}. ${prompt.label}`}><textarea rows={3} value={answers[prompt.key] ?? ""} onChange={(e) => setAnswers((current) => ({ ...current, [prompt.key]: e.target.value }))} placeholder={prompt.placeholder} /></Field>)}</div>
        <div className="review-submit"><span>{filled} of {prompts[cadence].length} reflections written</span><Button disabled={!filled} onClick={submit}>{saved ? <><Check size={16} /> Saved</> : <><BookOpenCheck size={16} /> Save reflection</>}</Button></div>
      </Panel>
      <aside className="review-history">
        <div className="section-heading compact"><div><p className="eyebrow">Permanent record</p><h2>Review history</h2></div><CalendarCheck size={19} /></div>
        {state.reviews.length ? state.reviews.slice(0, 12).map((review) => <details key={review.id} className="review-history-card panel"><summary><span className={`review-cadence ${review.cadence}`}>{review.cadence.slice(0, 1).toUpperCase()}</span><div><strong>{review.cadence[0].toUpperCase() + review.cadence.slice(1)} review</strong><small><Clock3 size={12} /> {formatDate(review.createdAt)}</small></div><ChevronDown size={16} /></summary><div>{Object.entries(review.answers).filter(([, answer]) => answer).map(([key, answer]) => <section key={key}><small>{prompts[review.cadence].find((item) => item.key === key)?.label ?? key}</small><p>{answer}</p></section>)}</div></details>) : <EmptyState icon={<BookOpenCheck />} title="Your first reflection awaits" body="A review creates context around the numbers and preserves what you learned." />}
      </aside>
    </div>
  </div>;
}
