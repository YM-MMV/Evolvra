"use client";

import Link from "next/link";
import { Activity, ArrowUpRight, BarChart3, CalendarRange, Sparkles } from "lucide-react";
import { useState } from "react";
import { useWorkspaceData } from "@/components/app-provider";
import { DynamicIcon } from "@/components/icons";
import { Panel } from "@/components/ui";
import { completionAreaShares, completionAttribution, metricEntryStatIds } from "@/lib/activity-attribution";
import { buildQualityActivitySeries } from "@/lib/quality-history";
import { terminologyForms } from "@/lib/terminology";
import { timelineHref } from "@/lib/timeline";
import type { Goal } from "@/lib/types";
import { formatDate, localDateKey } from "@/lib/utils";

type RecordedMoment = {
  id: string;
  at: string;
  goalId: string;
  goalIds: string[];
  areaIds: string[];
  statIds: string[];
  title: string;
  kinds: string[];
  href: string;
  sourceCompletionId?: string;
};

const validInstant = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const nearInstant = (left: string, right: string) => {
  const leftDate = validInstant(left);
  const rightDate = validInstant(right);
  return Boolean(leftDate && rightDate && Math.abs(leftDate.getTime() - rightDate.getTime()) <= 1_000);
};

const makeCalendarStart = (today: Date, daysAgo: number) => {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - daysAgo);
  return start;
};

const formatDuration = (minutes: number) => {
  if (minutes <= 0) return "No time logged";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}m logged`;
  return remainder ? `${hours}h ${remainder}m logged` : `${hours}h logged`;
};

const goalFor = (goals: Goal[], goalId: string) => goals.find((goal) => goal.id === goalId);

export default function StatsPage() {
  const { state } = useWorkspaceData();
  const terms = terminologyForms(state.settings.terminology);
  const [windowDays, setWindowDays] = useState<30 | 90 | 365>(30);
  const [now] = useState(() => new Date());
  const visibleStats = state.stats.filter((stat) => !stat.archived);
  const immutableMoments: RecordedMoment[] = [
    ...state.questCompletions.map((completion) => ({
      id: `quest-${completion.id}`,
      at: completion.completedAt,
      goalId: completion.goalId,
      ...completionAttribution(completion, state.goals, state.timeline),
      title: completion.title,
      kinds: ["action"],
      href: `/timeline#event-record-quest-${completion.id}`,
      sourceCompletionId: completion.id,
    })),
    ...state.metricEntries.map((entry) => {
      const goal = goalFor(state.goals, entry.goalId);
      const metric = goal?.metrics.find((item) => item.id === entry.metricId);
      return {
        id: `metric-${entry.id}`,
        at: entry.recordedAt,
        goalId: entry.goalId,
        goalIds: [entry.goalId],
        areaIds: entry.attribution?.areaId ? [entry.attribution.areaId] : goal ? [goal.areaId] : [],
        statIds: metricEntryStatIds(entry, state.goals),
        title: `${entry.label || metric?.label || "Measurement"} updated`,
        kinds: ["measurement"],
        href: `/timeline#event-record-metric-${entry.id}`,
        ...(entry.sourceCompletionId ? { sourceCompletionId: entry.sourceCompletionId } : {}),
      };
    }),
    ...state.goals.flatMap((goal) => goal.milestones
      .filter((milestone) => milestone.completedAt)
      .map((milestone) => ({
        id: `milestone-${goal.id}-${milestone.id}`,
        at: milestone.completedAt!,
        goalId: goal.id,
        goalIds: [goal.id],
        areaIds: [milestone.attribution?.areaId ?? goal.areaId],
        statIds: milestone.attribution?.statIds ?? goal.statIds,
        title: milestone.title,
        kinds: ["milestone"],
        href: `/timeline#event-record-milestone-${goal.id}-${milestone.id}`,
      }))),
    ...state.goals.flatMap((goal) => goal.checkIns.map((checkIn) => ({
      id: `check-in-${goal.id}-${checkIn.id}`,
      at: checkIn.createdAt,
      goalId: goal.id,
      goalIds: [goal.id],
      areaIds: [checkIn.attribution?.areaId ?? goal.areaId],
      statIds: checkIn.attribution?.statIds ?? goal.statIds,
      title: `Check-in for ${goal.title}`,
      kinds: ["check-in"],
      href: `/timeline#event-record-check-in-${goal.id}-${checkIn.id}`,
    }))),
  ].filter((moment) => validInstant(moment.at));
  const legacyMoments = state.timeline
    .filter((event) => {
      if (!event.goalId || !["quest", "metric", "milestone"].includes(event.type) || !validInstant(event.at)) return false;
      const kind = event.type === "quest" ? "action" : event.type === "metric" ? "measurement" : "milestone";
      return !immutableMoments.some((moment) => moment.goalIds.includes(event.goalId!) && moment.kinds.includes(kind) && nearInstant(moment.at, event.at));
    })
    .map((event): RecordedMoment => ({
      id: `timeline-${event.id}`,
      at: event.at,
      goalId: event.goalId!,
      goalIds: event.relatedGoalIds ?? [event.goalId!],
      areaIds: event.relatedAreaIds ?? (event.areaId
        ? [event.areaId]
        : goalFor(state.goals, event.goalId!)?.areaId
          ? [goalFor(state.goals, event.goalId!)!.areaId]
          : []),
      statIds: event.relatedStatIds ?? goalFor(state.goals, event.goalId!)?.statIds ?? [],
      title: event.title,
      kinds: [event.type === "quest" ? "action" : event.type === "metric" ? "measurement" : "milestone"],
      href: `/timeline#event-${event.id}`,
    }));
  const rawMoments = [...immutableMoments, ...legacyMoments];

  // A completed action can update a measurement at the same instant. Treat that as one
  // recorded moment while preserving both kinds of activity in its description.
  const moments = [...rawMoments.reduce((grouped, moment) => {
    const key = moment.sourceCompletionId ? `completion:${moment.sourceCompletionId}` : `record:${moment.id}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, moment);
    } else {
      grouped.set(key, {
        ...existing,
        goalIds: [...new Set([...existing.goalIds, ...moment.goalIds])],
        areaIds: [...new Set([...existing.areaIds, ...moment.areaIds])],
        statIds: [...new Set([...existing.statIds, ...moment.statIds])],
        kinds: [...new Set([...existing.kinds, ...moment.kinds])],
        title: existing.kinds.includes("action") ? existing.title : moment.title,
      });
    }
    return grouped;
  }, new Map<string, RecordedMoment>()).values()].sort((a, b) => (validInstant(b.at)?.getTime() ?? 0) - (validInstant(a.at)?.getTime() ?? 0));

  const currentStart = makeCalendarStart(now, windowDays - 1);
  const previousStart = makeCalendarStart(now, (windowDays * 2) - 1);
  const nextDay = makeCalendarStart(now, -1);
  const currentRange = { from: localDateKey(currentStart), to: localDateKey(now) };
  const previousRange = {
    from: localDateKey(previousStart),
    to: localDateKey(new Date(currentStart.getFullYear(), currentStart.getMonth(), currentStart.getDate() - 1)),
  };
  const inWindow = (moment: RecordedMoment, start: Date, end: Date) => {
    const date = validInstant(moment.at);
    return Boolean(date && date >= start && date < end);
  };
  const currentMoments = moments.filter((moment) => inWindow(moment, currentStart, nextDay));
  const previousMoments = moments.filter((moment) => inWindow(moment, previousStart, currentStart));
  const currentCompletions = state.questCompletions.filter((completion) => {
    const completedAt = validInstant(completion.completedAt);
    return Boolean(completedAt && completedAt >= currentStart && completedAt < nextDay);
  });
  const totalDurationMinutes = currentCompletions.reduce((total, completion) => total + Math.max(0, completion.durationMinutes ?? 0), 0);

  const recentByStat = visibleStats.map((stat) => {
    const connectedGoals = state.goals.filter((goal) => goal.status !== "archived" && goal.statIds.includes(stat.id));
    const activity = currentMoments.filter((moment) => moment.statIds.includes(stat.id));
    return { stat, recent: activity.slice(0, 3), connectedGoals, activity };
  });
  const ranked = [...recentByStat].sort((a, b) => b.activity.length - a.activity.length || b.connectedGoals.length - a.connectedGoals.length);
  const strongest = ranked.find((item) => item.activity.length > 0);
  const quietest = [...ranked].reverse()[0];
  const data = recentByStat.map(({ stat, activity }) => ({ name: stat.name, activity: activity.length }));
  const activitySummary = data.length
    ? data.map((item) => `${item.name}: ${item.activity}`).join(", ")
    : `No ${terms.stats.singularLower} activity has been recorded yet.`;
  const radarChart = { width: 460, height: 350, x: 230, y: 175, radius: 122 };
  const radarMax = Math.max(1, ...data.map((item) => item.activity));
  const radarPoint = (index: number, radius: number) => {
    const angle = (-Math.PI / 2) + ((Math.PI * 2 * index) / Math.max(1, data.length));
    return {
      x: radarChart.x + Math.cos(angle) * radius,
      y: radarChart.y + Math.sin(angle) * radius,
    };
  };
  const radarPolygon = (radiusFor: (activity: number) => number) => data
    .map((item, index) => {
      const point = radarPoint(index, radiusFor(item.activity));
      return `${point.x},${point.y}`;
    })
    .join(" ");
  const qualityHistory = buildQualityActivitySeries(
    moments,
    visibleStats.map((stat) => stat.id),
    currentStart,
    windowDays,
  );
  const historySummary = visibleStats.length
    ? visibleStats.map((stat) => `${stat.name}: ${qualityHistory.reduce((total, row) => total + (row.counts[stat.id] ?? 0), 0)}`).join(", ")
    : `No current ${terms.stats.pluralLower} are available.`;
  const historyChart = { width: 900, height: 280, left: 42, right: 16, top: 16, bottom: 34 };
  const historyMax = Math.max(
    1,
    ...qualityHistory.flatMap((row) => visibleStats.map((stat) => row.counts[stat.id] ?? 0)),
  );
  const historyTicks = [...new Set([historyMax, Math.round(historyMax * 0.75), Math.round(historyMax * 0.5), Math.round(historyMax * 0.25), 0])];
  const historyX = (index: number) => historyChart.left
    + (qualityHistory.length <= 1
      ? 0
      : index * ((historyChart.width - historyChart.left - historyChart.right) / (qualityHistory.length - 1)));
  const historyY = (value: number) => historyChart.top
    + (historyChart.height - historyChart.top - historyChart.bottom) * (1 - (value / historyMax));

  const change = currentMoments.length - previousMoments.length;
  const trendCopy = change === 0
    ? `The same number of recorded moments as the previous ${windowDays} calendar days (${previousMoments.length}).`
    : `${Math.abs(change)} ${change > 0 ? "more" : "fewer"} recorded ${Math.abs(change) === 1 ? "moment" : "moments"} than the previous ${windowDays} calendar days (${previousMoments.length}).`;

  const areaRows = state.areas
    .map((area) => {
      const activity = currentMoments.filter((moment) => moment.areaIds.includes(area.id)).length;
      const durationMinutes = currentCompletions
        .flatMap((completion) => completionAreaShares(completion, state.goals, state.timeline))
        .filter((share) => share.areaId === area.id)
        .reduce((total, share) => total + share.minutes, 0);
      const activeGoals = state.goals.filter((goal) => goal.areaId === area.id && goal.status === "active").length;
      return { area, activity, activeGoals, durationMinutes };
    })
    .filter(({ area, activity, activeGoals, durationMinutes }) => !area.hidden && (!area.archived || activity > 0 || activeGoals > 0 || durationMinutes > 0))
    .sort((a, b) => b.activity - a.activity || b.durationMinutes - a.durationMinutes || b.activeGoals - a.activeGoals || a.area.order - b.area.order);
  const activeGoalAreas = areaRows.filter((item) => item.activeGoals > 0);
  const activeGoalAreasWithActivity = activeGoalAreas.filter((item) => item.activity > 0).length;

  return <div>
    <section className="page-header"><div><p className="eyebrow">{terms.stats.plural} connected to your {terms.goals.pluralLower}</p><h1>Your {terms.stats.pluralLower}</h1><p className="page-lead">See how permanent {terms.quests.singularLower}, {terms.milestones.singularLower}, measurement, and check-in records connect to the {terms.stats.pluralLower} you chose for each {terms.goals.singularLower}.</p></div><div className="filter-tabs" role="group" aria-label="Analytics time window">{([30, 90, 365] as const).map((days) => <button key={days} type="button" className={windowDays === days ? "active" : ""} aria-pressed={windowDays === days} onClick={() => setWindowDays(days)}>{days}D</button>)}</div></section>
    <div className="stat-summary-grid">
      <Panel className="stat-hero-panel"><div className="section-heading compact"><div><p className="eyebrow">Last {windowDays} calendar days</p><h2>Recorded moments by {terms.stats.singularLower}</h2></div><span className="section-icon"><Activity size={19} /></span></div><div className="radar-wrap" role="img" aria-label={`Recorded moments by ${terms.stats.singularLower} in the last ${windowDays} days. ${activitySummary}`}>{data.length ? <svg viewBox={`0 0 ${radarChart.width} ${radarChart.height}`} aria-hidden="true" focusable="false">{[0.25, 0.5, 0.75, 1].map((ring) => data.length > 2 ? <polygon key={ring} points={radarPolygon(() => radarChart.radius * ring)} fill="none" stroke="var(--line)" /> : <circle key={ring} cx={radarChart.x} cy={radarChart.y} r={radarChart.radius * ring} fill="none" stroke="var(--line)" />)}{data.map((item, index) => { const edge = radarPoint(index, radarChart.radius); const label = radarPoint(index, radarChart.radius + 29); return <g key={item.name}><line x1={radarChart.x} y1={radarChart.y} x2={edge.x} y2={edge.y} stroke="var(--line)" /><text x={label.x} y={label.y + 4} textAnchor={Math.abs(label.x - radarChart.x) < 8 ? "middle" : label.x < radarChart.x ? "end" : "start"} fill="var(--muted)" fontSize="11">{item.name}</text></g>; })}{data.length > 2 ? <polygon points={radarPolygon((activity) => (activity / radarMax) * radarChart.radius)} fill="var(--accent)" fillOpacity="0.18" stroke="var(--accent)" strokeWidth="2" /> : data.map((item, index) => { const point = radarPoint(index, (item.activity / radarMax) * radarChart.radius); return <circle key={item.name} cx={point.x} cy={point.y} r="5" fill="var(--accent)" />; })}</svg> : <p className="supportive-copy">Add a {terms.stats.singularLower} to see its recorded activity here.</p>}</div><Link className="trace-source-link" href={timelineHref({ ...currentRange, type: "activity" })}>Inspect all source records<ArrowUpRight size={14} /></Link></Panel>
      <div className="stat-callouts">
        <Panel><span className="callout-icon positive"><BarChart3 /></span><div><p className="eyebrow">Most recorded connection</p>{strongest ? <Link className="trace-link" href={timelineHref({ ...currentRange, type: "activity", statId: strongest.stat.id })}><h3>{strongest.stat.name}</h3></Link> : <h3>No activity yet</h3>}<p>{strongest ? `${strongest.activity.length} recorded ${strongest.activity.length === 1 ? "moment" : "moments"} across ${strongest.connectedGoals.length} connected ${strongest.connectedGoals.length === 1 ? terms.goals.singularLower : terms.goals.pluralLower}.` : `Connect a ${terms.stats.singularLower} to a ${terms.goals.singularLower}; its permanent activity records will appear here.`}</p></div></Panel>
        <Panel><span className="callout-icon warm"><CalendarRange /></span><div><p className="eyebrow">Last {windowDays} calendar days</p><Link className="trace-link" href={timelineHref({ ...currentRange, type: "activity" })}><h3>{currentMoments.length} recorded {currentMoments.length === 1 ? "moment" : "moments"}</h3></Link><p>{trendCopy}</p></div></Panel>
        <Panel><span className="callout-icon"><Sparkles /></span><div><p className="eyebrow">Quietest current connection</p>{quietest ? <Link className="trace-link" href={timelineHref({ ...currentRange, type: "activity", statId: quietest.stat.id })}><h3>{quietest.stat.name}</h3></Link> : <h3>Your choice</h3>}<p>{quietest ? `${quietest.activity.length} recorded ${quietest.activity.length === 1 ? "moment" : "moments"} across its connected ${terms.goals.pluralLower}. This is context, not a judgement or target.` : `Every ${terms.stats.singularLower} can be shaped around what matters to you.`}</p></div></Panel>
      </div>
    </div>

    <section className="stats-section">
      <div className="section-heading"><div><p className="eyebrow">{terms.areas.singular} context</p><h2>Where activity was recorded</h2></div></div>
      <Panel>
        <div className="life-summary">
          <Link className="trace-link" href={timelineHref({ ...currentRange, type: "activity" })}><strong>{currentMoments.length}</strong><span>moments in the last {windowDays} days</span></Link>
          <Link className="trace-link" href={timelineHref({ ...previousRange, type: "activity" })}><strong>{previousMoments.length}</strong><span>moments in the previous {windowDays} days</span></Link>
          <Link className="trace-link" href={timelineHref({ ...currentRange, type: "quest" })}><strong>{formatDuration(totalDurationMinutes)}</strong><span>time recorded in completion details</span></Link>
        </div>
        {areaRows.length ? <div className="activity-list" role="list" aria-label={`Recorded moments and logged time by life ${terms.areas.singularLower} in the last ${windowDays} calendar days`}>{areaRows.map(({ area, activity, activeGoals, durationMinutes }) => <div key={area.id} role="listitem"><i className="area-dot" style={{ background: area.color }} /><div><Link className="trace-link" href={timelineHref({ ...currentRange, type: "activity", areaId: area.id })}><strong>{area.name}</strong></Link><small>{activeGoals} active {activeGoals === 1 ? terms.goals.singularLower : terms.goals.pluralLower} · {formatDuration(durationMinutes)}</small></div><b>{activity} {activity === 1 ? "moment" : "moments"}</b></div>)}</div> : <p className="supportive-copy">Add a {terms.goals.singularLower} to a life {terms.areas.singularLower} to begin seeing context. Equal activity across {terms.areas.pluralLower} is not expected or required.</p>}
        {areaRows.length ? <p className="supportive-copy">Counts use unique permanent records from the last {windowDays} local calendar days. A {terms.quests.singularLower} that updates a measurement at the same instant is counted once. Time includes only durations explicitly recorded on completions. {activeGoalAreasWithActivity} of {activeGoalAreas.length} {terms.areas.pluralLower} with active {terms.goals.pluralLower} had activity; this is context, not a target.</p> : null}
      </Panel>
    </section>

    <section className="stats-section">
      <div className="section-heading"><div><p className="eyebrow">Activity over time</p><h2>{terms.stats.singular} history</h2></div></div>
      <Panel>
        <div className="quality-history-wrap" role="img" aria-label={`Recorded moments over the last ${windowDays} calendar days. ${historySummary}`}>
          {visibleStats.length ? <>
            <svg viewBox={`0 0 ${historyChart.width} ${historyChart.height}`} aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
              {historyTicks.map((value) => {
                const y = historyY(value);
                return <g key={value}><line x1={historyChart.left} x2={historyChart.width - historyChart.right} y1={y} y2={y} stroke="var(--line)" /><text x={historyChart.left - 8} y={y + 4} textAnchor="end" fill="var(--muted)" fontSize="10">{value}</text></g>;
              })}
              {qualityHistory.map((row, index) => <text key={row.key} x={historyX(index)} y={historyChart.height - 9} textAnchor="middle" fill="var(--muted)" fontSize="10">{row.label}</text>)}
              {visibleStats.map((stat) => <polyline key={stat.id} points={qualityHistory.map((row, index) => `${historyX(index)},${historyY(row.counts[stat.id] ?? 0)}`).join(" ")} fill="none" stroke={stat.color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}
            </svg>
            <div className="quality-history-legend" aria-hidden="true">{visibleStats.map((stat) => <span key={stat.id}><i style={{ background: stat.color }} />{stat.name}</span>)}</div>
          </> : <p className="supportive-copy">Add a {terms.stats.singularLower} to see its recorded history here.</p>}
        </div>
        <p className="supportive-copy">Each line counts permanent records connected to that {terms.stats.singularLower} in local-calendar buckets. It is a history view, not a target.</p>
      </Panel>
    </section>

    <section className="stats-section"><div className="section-heading"><div><p className="eyebrow">Individual paths</p><h2>{terms.stats.singular} activity</h2></div></div><div className="stat-card-grid">{recentByStat.map(({ stat, recent, connectedGoals, activity }) => <Panel key={stat.id} className="stat-card"><div className="stat-card-head"><span style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} size={21} /></span><div><p>Recorded moments</p><strong>{activity.length}</strong></div></div><h3>{stat.name}</h3><div className="stat-context-copy"><span>{activity.length} in {windowDays} days</span><small>{connectedGoals.length} connected {connectedGoals.length === 1 ? terms.goals.singularLower : terms.goals.pluralLower}</small></div>{connectedGoals.length ? <div className="stat-goal-links" aria-label={`${terms.goals.plural} connected to ${stat.name}`}>{connectedGoals.slice(0, 3).map((goal) => <Link key={goal.id} href={`/goals/${goal.id}`}>{goal.title}</Link>)}{connectedGoals.length > 3 ? <small>+{connectedGoals.length - 3} more</small> : null}</div> : null}<div className="stat-recent"><small>Recent source records in this window</small>{recent.length ? recent.map((moment) => <div key={moment.id}><Link href={moment.href}>{moment.title}</Link><strong>{formatDate(moment.at)}</strong></div>) : <p>No permanent records in this window yet.</p>}</div><Link className="trace-source-link" href={timelineHref({ ...currentRange, type: "activity", statId: stat.id })}>Inspect all source records<ArrowUpRight size={14} /></Link><Link href="/settings#stats" className="card-arrow" aria-label={`Customise ${stat.name}`}><ArrowUpRight size={16} /></Link></Panel>)}</div></section>
  </div>;
}
