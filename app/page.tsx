"use client";

import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Flame, Plus, Sparkles, TrendingUp } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { DynamicIcon } from "@/components/icons";
import { GoalCard } from "@/components/goal-card";
import { LifeCalendar } from "@/components/life-calendar";
import { EmptyState, Panel, ProgressBar } from "@/components/ui";
import { getArea, levelFromXp } from "@/lib/utils";

export default function DashboardPage() {
  const { state, completeQuest } = useApp();
  const activeGoals = state.goals.filter((goal) => goal.status === "active");
  const todayQuests = activeGoals.flatMap((goal) => goal.quests.filter((quest) => !quest.completed).map((quest) => ({ quest, goal })));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - offset));
    const key = date.toISOString().slice(0, 10);
    return {
      key,
      label: date.toLocaleDateString("en-GB", { weekday: "short" }).slice(0, 1),
      xp: state.timeline.filter((event) => event.at.startsWith(key)).reduce((sum, event) => sum + (event.xp ?? 0), 0),
    };
  });
  const maxDay = Math.max(...days.map((day) => day.xp), 1);
  const weeklyXp = days.reduce((sum, day) => sum + day.xp, 0);
  const overallLevel = levelFromXp(state.overallXp, state.settings.scoring.levelBase, state.settings.scoring.levelGrowth);
  const developedStats = [...state.stats].filter((stat) => !stat.archived).sort((a, b) => b.xp - a.xp).slice(0, 4);

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
        <div className="dashboard-kpi"><span>Overall level</span><strong>{overallLevel.level}</strong><small>{Math.round(overallLevel.current)} / {overallLevel.needed} XP</small></div>
        <div className="dashboard-kpi"><span>Total XP</span><strong>{Math.round(state.overallXp)}</strong><small>All-time progress</small></div>
        <div className="dashboard-kpi"><span>Active goals</span><strong>{activeGoals.length}</strong><small>Current objectives</small></div>
        <div className="dashboard-kpi"><span>7-day XP</span><strong>{weeklyXp}</strong><small>Recent momentum</small></div>
      </section>

      <div className="dashboard-command-grid">
        <aside className="dashboard-command-rail">
          <Panel className="today-panel">
            <div className="section-heading compact"><div><p className="eyebrow">Next actions</p><h2>Today’s quests</h2></div><span className="count-badge">{todayQuests.length}</span></div>
            <div className="quest-mini-list">
              {todayQuests.slice(0, 5).map(({ quest, goal }) => {
                const area = getArea(state, goal.areaId);
                return <div className="quest-mini" key={quest.id}><button onClick={() => completeQuest(goal.id, quest.id)} aria-label={`Complete ${quest.title}`}><Check size={15} /></button><div><strong>{quest.title}</strong><span><i style={{ background: area?.color }} />{goal.title}</span></div><small>+{quest.xp}</small></div>;
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
            <div className="momentum-total"><strong>{weeklyXp}</strong><span>XP earned this week</span></div>
            <div className="mini-chart">{days.map((day) => <div key={day.key}><span style={{ height: `${Math.max(6, (day.xp / maxDay) * 100)}%` }} title={`${day.xp} XP`} /><small>{day.label}</small></div>)}</div>
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
            <div className="section-heading compact"><div><p className="eyebrow">Character growth</p><h2>Developing stats</h2></div><span className="section-icon"><TrendingUp size={18} /></span></div>
            <div className="stats-mini-list">
              {developedStats.map((stat) => {
                const level = levelFromXp(stat.xp, state.settings.scoring.levelBase, state.settings.scoring.levelGrowth);
                return <div key={stat.id}><span className="stat-mini-icon" style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} size={16} /></span><div><span><strong>{stat.name}</strong><small>LVL {level.level}</small></span><ProgressBar value={level.percent} color={stat.color} /></div></div>;
              })}
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
