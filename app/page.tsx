"use client";

import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Flame, Plus, Sparkles, TrendingUp } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { DynamicIcon } from "@/components/icons";
import { GoalCard } from "@/components/goal-card";
import { LifeCalendar } from "@/components/life-calendar";
import { EmptyState, Panel } from "@/components/ui";
import { getArea } from "@/lib/utils";

export default function DashboardPage() {
  const { state, completeQuest } = useApp();
  const activeGoals = state.goals.filter((goal) => goal.status === "active");
  const todayKey = new Date().toLocaleDateString("en-CA");
  const todayQuests = activeGoals.flatMap((goal) => goal.quests.filter((quest) => !quest.completed && (!quest.dueDate || quest.dueDate <= todayKey)).map((quest) => ({ quest, goal })));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - offset));
    const key = date.toLocaleDateString("en-CA");
    return {
      key,
      label: date.toLocaleDateString("en-GB", { weekday: "short" }).slice(0, 1),
      activity: state.timeline.filter((event) => new Date(event.at).toLocaleDateString("en-CA") === key).length,
    };
  });
  const maxDay = Math.max(...days.map((day) => day.activity), 1);
  const weeklyActivity = days.reduce((sum, day) => sum + day.activity, 0);
  const milestoneCount = state.timeline.filter((event) => event.type === "milestone").length;
  const activityDays = new Set(state.timeline.map((event) => new Date(event.at).toLocaleDateString("en-CA"))).size;
  const developedStats = state.stats
    .filter((stat) => !stat.archived)
    .map((stat) => {
      const goalIds = state.goals.filter((goal) => goal.statIds.includes(stat.id)).map((goal) => goal.id);
      const activity = state.timeline.filter((event) => event.goalId && goalIds.includes(event.goalId) && ["quest", "milestone", "metric"].includes(event.type)).length;
      return { stat, activity, goals: goalIds.length };
    })
    .sort((a, b) => b.activity - a.activity || b.goals - a.goals)
    .slice(0, 4);

  return (
    <div className="dashboard-page">
      <section className="hero-row">
        <div>
          <p className="eyebrow">{greeting}, {state.profile.displayName}</p>
          <h1>What will move your life forward?</h1>
          <p className="page-lead">Choose the next meaningful action. Quiet progress still counts.</p>
        </div>
        <div className="hero-actions"><Link href="/quests" className="button button-secondary">View today <ArrowRight size={17} /></Link><Link href="/goals?new=true" className="button button-primary"><Plus size={17} /> New goal</Link></div>
      </section>

      <section className="dashboard-kpis" aria-label="Progress overview">
        <div className="dashboard-kpi"><span>Active goals</span><strong>{activeGoals.length}</strong><small>Current objectives</small></div>
        <div className="dashboard-kpi"><span>Actions completed</span><strong>{state.questCompletions.length}</strong><small>All-time record</small></div>
        <div className="dashboard-kpi"><span>Milestones reached</span><strong>{milestoneCount}</strong><small>All-time record</small></div>
        <div className="dashboard-kpi"><span>Active days</span><strong>{activityDays}</strong><small>Days with a recorded moment</small></div>
      </section>

      <div className="dashboard-command-grid">
        <aside className="dashboard-command-rail">
          <Panel className="today-panel">
            <div className="section-heading compact"><div><p className="eyebrow">Next actions</p><h2>Today’s quests</h2></div><span className="count-badge">{todayQuests.length}</span></div>
            <div className="quest-mini-list">
              {todayQuests.slice(0, 5).map(({ quest, goal }) => {
                const area = getArea(state, goal.areaId);
                return <div className="quest-mini" key={quest.id}><button onClick={() => completeQuest(goal.id, quest.id)} aria-label={`Complete ${quest.title}`}><Check size={15} /></button><div><strong>{quest.title}</strong><span><i style={{ background: area?.color }} />{goal.title}</span></div><small>{quest.durationMinutes ? `${quest.durationMinutes} min` : "Ready"}</small></div>;
              })}
              {!todayQuests.length && <div className="calm-empty"><Check size={20} /><strong>Clear for now</strong><p>Add a next action when you are ready.</p></div>}
            </div>
            <Link href="/quests" className="panel-link">Open quest board <ArrowRight size={15} /></Link>
          </Panel>
        </aside>

        <div className="dashboard-command-main">
          <LifeCalendar />
          <Panel className="momentum-panel">
            <div className="section-heading compact"><div><p className="eyebrow">Last 7 days</p><h2>Momentum</h2></div><span className="section-icon warm"><Flame size={18} /></span></div>
            <div className="momentum-total"><strong>{weeklyActivity}</strong><span>recorded moments this week</span></div>
            <div className="mini-chart">{days.map((day) => <div key={day.key}><span style={{ height: `${day.activity ? Math.max(6, (day.activity / maxDay) * 100) : 0}%` }} title={`${day.activity} recorded ${day.activity === 1 ? "moment" : "moments"}`} /><small>{day.label}</small></div>)}</div>
            <p className="supportive-copy">Momentum describes recent activity. It is information, never a verdict.</p>
          </Panel>
        </div>
      </div>

      <div className="dashboard-grid dashboard-followup-grid">
        <div className="dashboard-primary">
          <section>
            <div className="section-heading"><div><p className="eyebrow">Active objectives</p><h2>Your current goals</h2></div><Link href="/goals">View all <ChevronRight size={16} /></Link></div>
            {activeGoals.length ? <div className="goal-grid">{activeGoals.slice(0, 4).map((goal) => <GoalCard key={goal.id} goal={goal} area={getArea(state, goal.areaId)} />)}</div> : <EmptyState icon={<Sparkles />} title="A clear field" body="Create your first goal and define what genuine progress looks like." action={<Link href="/goals?new=true" className="button button-primary">Create a goal</Link>} />}
          </section>
        </div>

        <aside className="dashboard-rail">
          <Panel className="stats-mini-panel">
            <div className="section-heading compact"><div><p className="eyebrow">Qualities in motion</p><h2>Connected stats</h2></div><span className="section-icon"><TrendingUp size={18} /></span></div>
            <div className="stats-mini-list">
              {developedStats.map(({ stat, activity, goals }) => <div key={stat.id}><span className="stat-mini-icon" style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} size={16} /></span><div><span><strong>{stat.name}</strong><small>{activity} {activity === 1 ? "moment" : "moments"}</small></span><small>{goals} connected {goals === 1 ? "goal" : "goals"}</small></div></div>)}
            </div>
            <Link href="/stats" className="panel-link">Explore all stats <ArrowRight size={15} /></Link>
          </Panel>

          <Panel className="review-nudge">
            <span className="review-orb"><Sparkles size={20} /></span>
            <div><p className="eyebrow">Reflection</p><h3>Make sense of the week</h3><p>Notice movement, blockers, and what deserves attention next.</p></div>
            <Link href="/reviews" className="button button-secondary">Start a review</Link>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
