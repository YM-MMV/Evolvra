"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Flame, Plus, Sparkles, TrendingUp } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { DynamicIcon } from "@/components/icons";
import { GoalCard } from "@/components/goal-card";
import { collectActivityMoments, LifeCalendar } from "@/components/life-calendar";
import { QuestCompletionForm } from "@/components/quest-completion-form";
import { EmptyState, Panel } from "@/components/ui";
import { timelineHref } from "@/lib/timeline";
import type { DashboardSectionId } from "@/lib/types";
import { getArea, isQuestAvailable, isQuestDue, localDateKey, singularizeTerm } from "@/lib/utils";

export default function DashboardPage() {
  const { state } = useApp();
  const terms = state.settings.terminology;
  const goalTerm = singularizeTerm(terms.goals);
  const questTerm = singularizeTerm(terms.quests);
  const [completionTarget, setCompletionTarget] = useState<{ goalId: string; questId: string } | null>(null);
  const activeGoals = state.goals.filter((goal) => goal.status === "active");
  const todayQuests = activeGoals.flatMap((goal) => goal.quests.filter((quest) => isQuestDue(quest)).map((quest) => ({ quest, goal })));
  const activityMoments = collectActivityMoments(state);
  const activityByDate = activityMoments.reduce<Record<string, number>>((counts, moment) => {
    const key = localDateKey(new Date(moment.at));
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - offset));
    const key = localDateKey(date);
    return {
      key,
      label: date.toLocaleDateString("en-GB", { weekday: "short" }).slice(0, 1),
      activity: activityByDate[key] ?? 0,
    };
  });
  const maxDay = Math.max(...days.map((day) => day.activity), 1);
  const weeklyActivity = days.reduce((sum, day) => sum + day.activity, 0);
  const weeklyActivityHref = timelineHref({ type: "activity", from: days[0].key, to: days[days.length - 1].key });
  const milestoneCount = state.goals.flatMap((goal) => goal.milestones).filter((milestone) => milestone.completedAt).length;
  const activityDays = Object.keys(activityByDate).length;
  const developedStats = state.stats
    .filter((stat) => !stat.archived)
    .map((stat) => {
      const goalIds = state.goals.filter((goal) => goal.statIds.includes(stat.id)).map((goal) => goal.id);
      const activity = activityMoments.filter((moment) => moment.statIds.includes(stat.id)).length;
      return { stat, activity, goals: goalIds.length };
    })
    .sort((a, b) => b.activity - a.activity || b.goals - a.goals)
    .slice(0, 4);
  const selectedGoal = completionTarget ? state.goals.find((goal) => goal.id === completionTarget.goalId) : undefined;
  const selectedQuest = selectedGoal?.quests.find((quest) => quest.id === completionTarget?.questId);
  const canCompleteSelection = selectedGoal?.status === "active" && selectedQuest && isQuestAvailable(selectedQuest);

  const dashboardSections: Record<DashboardSectionId, ReactNode> = {
    "life-map": <div id="dashboard-life-map"><LifeCalendar /></div>,
    momentum: (
      <Panel id="dashboard-momentum" className="momentum-panel">
        <div className="section-heading compact"><div><p className="eyebrow">Last 7 days</p><h2>Momentum</h2></div><span className="section-icon warm" aria-hidden="true"><Flame size={18} /></span></div>
        <Link className="momentum-total trace-link" href={weeklyActivityHref} aria-label={`Inspect ${weeklyActivity} recorded moments from the last seven days`}><strong>{weeklyActivity}</strong><span>recorded moments in the last seven days</span></Link>
        <div className="mini-chart" role="img" aria-label={`Activity over the last seven days: ${days.map((day) => `${day.activity} on ${day.key}`).join(", ")}`}>{days.map((day) => <div key={day.key} aria-hidden="true"><span style={{ height: `${day.activity ? Math.max(6, (day.activity / maxDay) * 100) : 0}%` }} title={`${day.activity} recorded ${day.activity === 1 ? "moment" : "moments"}`} /><small>{day.label}</small></div>)}</div>
        <p className="supportive-copy">Momentum describes recent activity. It is information, never a verdict. <Link className="trace-link" href={weeklyActivityHref}>Open source records</Link>.</p>
      </Panel>
    ),
    goals: (
      <section id="dashboard-goals">
        <div className="section-heading"><div><p className="eyebrow">Active objectives</p><h2>Your current {terms.goals.toLowerCase()}</h2></div><Link href="/goals">View all <ChevronRight size={16} aria-hidden="true" /></Link></div>
        {activeGoals.length ? <div className="goal-grid">{activeGoals.slice(0, 4).map((goal) => <GoalCard key={goal.id} goal={goal} area={getArea(state, goal.areaId)} />)}</div> : <EmptyState icon={<Sparkles />} title="A clear field" body={`Create your first ${goalTerm.toLowerCase()} and define what genuine progress looks like.`} action={<Link href="/goals?new=true" className="button button-primary">Create a {goalTerm.toLowerCase()}</Link>} />}
      </section>
    ),
    qualities: (
      <Panel id="dashboard-qualities" className="stats-mini-panel">
        <div className="section-heading compact"><div><p className="eyebrow">Qualities in motion</p><h2>Connected {terms.stats.toLowerCase()}</h2></div><span className="section-icon" aria-hidden="true"><TrendingUp size={18} /></span></div>
        {developedStats.length ? (
          <div className="stats-mini-list">
            {developedStats.map(({ stat, activity, goals }) => <div key={stat.id}><span className="stat-mini-icon" style={{ color: stat.color, background: `${stat.color}18` }} aria-hidden="true"><DynamicIcon name={stat.icon} size={16} /></span><Link className="quality-trace trace-link" href={timelineHref({ type: "activity", statId: stat.id })} aria-label={`Inspect source records connected to ${stat.name}`}><span><strong>{stat.name}</strong><small>{activity} {activity === 1 ? "moment" : "moments"}</small></span><small>{goals} connected {goals === 1 ? goalTerm.toLowerCase() : terms.goals.toLowerCase()}</small></Link></div>)}
          </div>
        ) : <div className="calm-empty"><TrendingUp size={20} aria-hidden="true" /><strong>No connected qualities yet</strong><p>Connect a quality to a {goalTerm.toLowerCase()} when that relationship is useful.</p></div>}
        <Link href="/stats" className="panel-link">Explore all {terms.stats.toLowerCase()} <ArrowRight size={15} aria-hidden="true" /></Link>
      </Panel>
    ),
    review: (
      <Panel id="dashboard-review" className="review-nudge">
        <span className="review-orb" aria-hidden="true"><Sparkles size={20} /></span>
        <div><p className="eyebrow">Reflection</p><h3>Make sense of the week</h3><p>Notice movement, blockers, and what deserves attention next.</p></div>
        <Link href="/reviews" className="button button-secondary">Start a review</Link>
      </Panel>
    ),
  };
  const defaultOrder: DashboardSectionId[] = ["life-map", "momentum", "goals", "qualities", "review"];
  const orderedSections = [...state.settings.dashboardOrder, ...defaultOrder.filter((section) => !state.settings.dashboardOrder.includes(section))]
    .filter((section, index, sections) => sections.indexOf(section) === index)
    .filter((section) => !state.settings.hiddenDashboardSections.includes(section));

  return (
    <div className="dashboard-page">
      <section className="hero-row">
        <div>
          <p className="eyebrow">{greeting}, {state.profile.displayName}</p>
          <h1>What will move your life forward?</h1>
          <p className="page-lead">Choose the next meaningful action. Quiet progress still counts.</p>
        </div>
        <div className="hero-actions"><Link href="/quests" className="button button-secondary">View today <ArrowRight size={17} aria-hidden="true" /></Link><Link href="/goals?new=true" className="button button-primary"><Plus size={17} aria-hidden="true" /> New {goalTerm.toLowerCase()}</Link></div>
      </section>

      <section className="dashboard-kpis" aria-label="Progress overview">
        <Link className="dashboard-kpi" href="/goals" aria-label={`Open current objectives: ${activeGoals.length} active`}><span>Active {terms.goals.toLowerCase()}</span><strong>{activeGoals.length}</strong><small>Open current objectives</small></Link>
        <Link className="dashboard-kpi" href={timelineHref({ type: "quest" })} aria-label={`Inspect ${state.questCompletions.length} completed actions`}><span>Actions completed</span><strong>{state.questCompletions.length}</strong><small>Inspect source records</small></Link>
        <Link className="dashboard-kpi" href={timelineHref({ type: "milestone" })} aria-label={`Inspect ${milestoneCount} reached ${terms.milestones.toLowerCase()}`}><span>{terms.milestones} reached</span><strong>{milestoneCount}</strong><small>Inspect source records</small></Link>
        <Link className="dashboard-kpi" href={timelineHref({ type: "activity" })} aria-label={`Inspect ${activityDays} active days`}><span>Active days</span><strong>{activityDays}</strong><small>Inspect recorded moments</small></Link>
      </section>

      <div className="dashboard-command-grid">
        <aside className="dashboard-command-rail">
          <Panel className="today-panel">
            <div className="section-heading compact"><div><p className="eyebrow">Due now</p><h2>Today &amp; overdue</h2></div><span className="count-badge">{todayQuests.length}</span></div>
            <div className="quest-mini-list">
              {todayQuests.slice(0, 5).map(({ quest, goal }) => {
                const area = getArea(state, goal.areaId);
                return <div className="quest-mini" key={`${goal.id}:${quest.id}`}><button type="button" onClick={() => setCompletionTarget({ goalId: goal.id, questId: quest.id })} aria-label={`Record completion of ${quest.title}`}><Check size={15} aria-hidden="true" /></button><div><strong>{quest.title}</strong><span><i style={{ background: area?.color }} aria-hidden="true" />{goal.title}</span></div><small>{quest.durationMinutes !== undefined ? `${quest.durationMinutes} planned min` : "Ready"}</small></div>;
              })}
              {!todayQuests.length && <div className="calm-empty"><Check size={20} aria-hidden="true" /><strong>Nothing due now</strong><p>Undated actions stay in Anytime on the {terms.quests.toLowerCase()} board.</p></div>}
            </div>
            <Link href="/quests" className="panel-link">Open {questTerm.toLowerCase()} board <ArrowRight size={15} aria-hidden="true" /></Link>
          </Panel>
        </aside>

        <div className="dashboard-command-main">
          {orderedSections.map((section) => <div key={section}>{dashboardSections[section]}</div>)}
          {!orderedSections.length && <Panel><div className="calm-empty"><Sparkles size={20} aria-hidden="true" /><strong>Your dashboard is clear</strong><p>Restore any section from dashboard arrangement in settings.</p><Link href="/settings" className="panel-link">Open settings <ArrowRight size={15} aria-hidden="true" /></Link></div></Panel>}
        </div>
      </div>
      {completionTarget && canCompleteSelection && selectedQuest && <QuestCompletionForm key={`${completionTarget.goalId}:${completionTarget.questId}`} goalId={completionTarget.goalId} quest={selectedQuest} open onClose={() => setCompletionTarget(null)} />}
    </div>
  );
}
