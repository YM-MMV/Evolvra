"use client";

import { Activity, ArrowUpRight, BarChart3, Sparkles, TrendingUp } from "lucide-react";
import { PolarAngleAxis, PolarGrid, Radar, RadarChart, ResponsiveContainer, Tooltip } from "recharts";
import { useApp } from "@/components/app-provider";
import { DynamicIcon } from "@/components/icons";
import { Panel } from "@/components/ui";
import { formatDate } from "@/lib/utils";

export default function StatsPage() {
  const { state } = useApp();
  const visibleStats = state.stats.filter((stat) => !stat.archived);
  const recentByStat = visibleStats.map((stat) => {
    const goalIds = state.goals.filter((goal) => goal.statIds.includes(stat.id)).map((goal) => goal.id);
    const activity = state.timeline.filter((event) => event.goalId && goalIds.includes(event.goalId) && ["quest", "milestone", "metric"].includes(event.type));
    return { stat, recent: activity.slice(0, 3), goals: goalIds.length, activity: activity.length };
  });
  const ranked = [...recentByStat].sort((a, b) => b.activity - a.activity || b.goals - a.goals);
  const totalActivity = recentByStat.reduce((sum, item) => sum + item.activity, 0);
  const strongest = totalActivity ? ranked[0] : undefined;
  const opportunity = ranked.at(-1);
  const data = recentByStat.map(({ stat, activity }) => ({ name: stat.name, activity }));
  const activitySummary = data.length
    ? data.map((item) => `${item.name}: ${item.activity}`).join(", ")
    : "No quality activity has been recorded yet.";

  return <div>
    <section className="page-header"><div><p className="eyebrow">Qualities connected to your goals</p><h1>Your {state.settings.terminology.stats.toLowerCase()}</h1><p className="page-lead">See where your goals connect and where completed actions, milestones, and measurements have created a record of activity.</p></div></section>
    <div className="stat-summary-grid">
      <Panel className="stat-hero-panel"><div className="section-heading compact"><div><p className="eyebrow">Activity profile</p><h2>Recorded contributions</h2></div><span className="section-icon"><Activity size={19} /></span></div><div className="radar-wrap" role="img" aria-label={`Recorded contributions by quality. ${activitySummary}`}><ResponsiveContainer width="100%" height="100%"><RadarChart data={data} outerRadius="68%"><PolarGrid stroke="var(--line)" /><PolarAngleAxis dataKey="name" tick={{ fill: "var(--muted)", fontSize: 11 }} /><Radar dataKey="activity" name="Recorded activity" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.18} strokeWidth={2} /><Tooltip contentStyle={{ background: "var(--panel-solid)", border: "1px solid var(--line-strong)", borderRadius: 4 }} /></RadarChart></ResponsiveContainer></div></Panel>
      <div className="stat-callouts">
        <Panel><span className="callout-icon positive"><TrendingUp /></span><div><p className="eyebrow">Most active connection</p><h3>{strongest?.stat.name ?? "Start exploring"}</h3><p>{strongest ? `${strongest.activity} recorded ${strongest.activity === 1 ? "moment" : "moments"} across ${strongest.goals} connected ${strongest.goals === 1 ? "goal" : "goals"}.` : "Connect a quality to a goal to begin its activity record."}</p></div></Panel>
        <Panel><span className="callout-icon"><Sparkles /></span><div><p className="eyebrow">Room for attention</p><h3>{opportunity?.stat.name ?? "Your choice"}</h3><p>{opportunity ? `${opportunity.activity} recorded ${opportunity.activity === 1 ? "moment" : "moments"}. This is context for planning, not a judgement.` : "Every path can be shaped around what matters to you."}</p></div></Panel>
        <Panel><span className="callout-icon warm"><BarChart3 /></span><div><p className="eyebrow">All-time activity</p><h3>{totalActivity} contributions</h3><p>Each count comes from a completed action, milestone, or metric update connected to a quality.</p></div></Panel>
      </div>
    </div>
    <section className="stats-section"><div className="section-heading"><div><p className="eyebrow">Individual paths</p><h2>Quality activity</h2></div></div><div className="stat-card-grid">{recentByStat.map(({ stat, recent, goals, activity }) => <Panel key={stat.id} className="stat-card"><div className="stat-card-head"><span style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} size={21} /></span><div><p>Activity</p><strong>{activity}</strong></div></div><h3>{stat.name}</h3><div className="stat-context-copy"><span>{activity} recorded {activity === 1 ? "moment" : "moments"}</span><small>{goals} connected {goals === 1 ? "goal" : "goals"}</small></div><div className="stat-recent"><small>Recent contribution</small>{recent.length ? recent.map((event) => <div key={event.id}><span>{event.title}</span><strong>{formatDate(event.at)}</strong></div>) : <p>Ready for its first contribution.</p>}</div><a href="/settings#stats" className="card-arrow" aria-label={`Customise ${stat.name}`}><ArrowUpRight size={16} /></a></Panel>)}</div></section>
  </div>;
}
