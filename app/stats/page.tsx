"use client";

import { Activity, ArrowUpRight, BarChart3, Sparkles, TrendingUp } from "lucide-react";
import { PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip } from "recharts";
import { useApp } from "@/components/app-provider";
import { DynamicIcon } from "@/components/icons";
import { Panel, ProgressBar } from "@/components/ui";
import { levelFromXp } from "@/lib/utils";

export default function StatsPage() {
  const { state } = useApp();
  const visibleStats = state.stats.filter((stat) => !stat.archived);
  const data = visibleStats.map((stat) => ({ name: stat.name, value: Math.max(8, Math.min(100, levelFromXp(stat.xp, state.settings.scoring.levelBase, state.settings.scoring.levelGrowth).level * 12 + (stat.xp % 100) / 10)) }));
  const ranked = [...visibleStats].sort((a, b) => b.xp - a.xp);
  const totalStatXp = visibleStats.reduce((sum, stat) => sum + stat.xp, 0);
  const strongest = ranked[0];
  const opportunity = ranked.at(-1);

  const recentByStat = visibleStats.map((stat) => {
    const goalIds = state.goals.filter((goal) => goal.statWeights[stat.id]).map((goal) => goal.id);
    const recent = state.timeline.filter((event) => event.goalId && goalIds.includes(event.goalId) && event.xp).slice(0, 3);
    return { stat, recent, goals: goalIds.length };
  });

  return <div>
    <section className="page-header"><div><p className="eyebrow">Permanent character growth</p><h1>Your {state.settings.terminology.stats.toLowerCase()}</h1><p className="page-lead">A record of qualities developed through meaningful effort. Lower values are growth opportunities, never weaknesses.</p></div></section>
    <div className="stat-summary-grid">
      <Panel className="stat-hero-panel"><div className="section-heading compact"><div><p className="eyebrow">Development profile</p><h2>Character radar</h2></div><span className="section-icon"><Activity size={19} /></span></div><div className="radar-wrap"><ResponsiveContainer width="100%" height="100%"><RadarChart data={data} outerRadius="68%"><PolarGrid stroke="var(--line)" /><PolarAngleAxis dataKey="name" tick={{ fill: "var(--muted)", fontSize: 11 }} /><Radar dataKey="value" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.18} strokeWidth={2} /><Tooltip contentStyle={{ background: "var(--panel-solid)", border: "1px solid var(--line-strong)", borderRadius: 4 }} /></RadarChart></ResponsiveContainer></div></Panel>
      <div className="stat-callouts">
        <Panel><span className="callout-icon positive"><TrendingUp /></span><div><p className="eyebrow">Most developed</p><h3>{strongest?.name ?? "Start exploring"}</h3><p>{strongest ? `${Math.round(strongest.xp)} XP accumulated through connected goals.` : "Stats grow when you complete meaningful quests."}</p></div></Panel>
        <Panel><span className="callout-icon"><Sparkles /></span><div><p className="eyebrow">Growth opportunity</p><h3>{opportunity?.name ?? "Your choice"}</h3><p>{opportunity ? "A less-developed area you can choose to nurture — no pressure attached." : "Every path can be shaped around what matters to you."}</p></div></Panel>
        <Panel><span className="callout-icon warm"><BarChart3 /></span><div><p className="eyebrow">All-time development</p><h3>{Math.round(totalStatXp)} stat XP</h3><p>XP is never removed for pauses, missed days, or changing direction.</p></div></Panel>
      </div>
    </div>
    <section className="stats-section"><div className="section-heading"><div><p className="eyebrow">Individual paths</p><h2>Stat progression</h2></div></div><div className="stat-card-grid">{recentByStat.map(({ stat, recent, goals }) => { const level = levelFromXp(stat.xp, state.settings.scoring.levelBase, state.settings.scoring.levelGrowth); return <Panel key={stat.id} className="stat-card"><div className="stat-card-head"><span style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} size={21} /></span><div><p>Level</p><strong>{level.level}</strong></div></div><h3>{stat.name}</h3><div className="stat-level-copy"><span>{Math.round(level.current)} / {level.needed} XP</span><small>{goals} connected {goals === 1 ? "goal" : "goals"}</small></div><ProgressBar value={level.percent} color={stat.color} /><div className="stat-recent"><small>Recent contribution</small>{recent.length ? recent.map((event) => <div key={event.id}><span>{event.title}</span><strong>+{Math.round((event.xp ?? 0) * ((state.goals.find((goal) => goal.id === event.goalId)?.statWeights[stat.id] ?? 0) / 100))}</strong></div>) : <p>Ready for its first contribution.</p>}</div><a href={`/settings#stats`} className="card-arrow" aria-label={`Customise ${stat.name}`}><ArrowUpRight size={16} /></a></Panel>; })}</div></section>
  </div>;
}
