"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BookOpenCheck, CalendarCheck, Check, ChevronDown, Clock3, Sparkles } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, EmptyState, Field, Panel } from "@/components/ui";
import { completionAreaShares, completionGoalIds, completionStatIds, metricEntryStatIds } from "@/lib/activity-attribution";
import { timelineHref, type TimelineFilters } from "@/lib/timeline";
import { reviewPromptLabel, reviewPromptsFor } from "@/lib/review-prompts";
import { WORKSPACE_TEXT_LIMITS } from "@/lib/state-schema";
import type { Goal, ReviewCadence } from "@/lib/types";
import { formatDate, localDateKey, parseLocalDate, singularizeTerm, uid } from "@/lib/utils";

const validInstant = (value?: string) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const startOfWeek = (today: Date) => {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
};

const nearInstant = (left: string, right: string) => {
  const leftDate = validInstant(left);
  const rightDate = validInstant(right);
  return Boolean(leftDate && rightDate && Math.abs(leftDate.getTime() - rightDate.getTime()) <= 1_000);
};

const formatMinutes = (minutes: number) => {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  if (!hours) return `${remainder}m`;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
};

const formatMeasurement = (value: number, unit: string) => {
  const number = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (unit === "£" || unit === "$" || unit === "€") return `${unit}${number}`;
  return `${number}${unit ? ` ${unit}` : ""}`;
};

const latestGoalActivity = (goal: Goal, questDates: string[], metricDates: string[]) => {
  const dates = [
    ...questDates,
    ...metricDates,
    ...goal.milestones.map((milestone) => milestone.completedAt).filter((date): date is string => Boolean(date)),
    ...goal.checkIns.map((checkIn) => checkIn.createdAt),
  ]
    .map(validInstant)
    .filter((date): date is Date => Boolean(date));
  return dates.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
};

type ReviewSourceRecord = {
  id: string;
  title: string;
  detail: string;
  at: string;
  goalId?: string;
  href: string;
};

type MetricMovement = {
  key: string;
  goalId: string;
  goalTitle: string;
  label: string;
  unit: string;
  from: number;
  to: number;
  updates: number;
  href: string;
};

export default function ReviewsPage() {
  const { state, addReview } = useApp();
  const [cadence, setCadence] = useState<ReviewCadence>("weekly");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [visibleReviews, setVisibleReviews] = useState(12);
  const terms = state.settings.terminology;
  const prompts = reviewPromptsFor(terms);
  const goalTerm = singularizeTerm(terms.goals);
  const milestoneTerm = singularizeTerm(terms.milestones);
  const areaTerm = singularizeTerm(terms.areas);
  const reviewContext = useMemo(() => {
    const now = new Date();
    const weekStart = startOfWeek(now);
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const todayKey = localDateKey(now);
    const weekRange = { from: localDateKey(weekStart), to: todayKey };
    const currentMonthRange = { from: localDateKey(monthStart), to: todayKey };
    const previousMonthRange = { from: localDateKey(previousMonthStart), to: localDateKey(previousMonthEnd) };
    const inThisWeek = (value: string) => {
      const date = validInstant(value);
      return Boolean(date && date >= weekStart && date < tomorrow);
    };

    const weeklyQuests = state.questCompletions.filter((completion) => inThisWeek(completion.completedAt));
    const weeklyMetrics = state.metricEntries.filter((entry) => inThisWeek(entry.recordedAt));
    const weeklyMilestones = state.goals.flatMap((goal) => goal.milestones
      .filter((milestone) => milestone.completedAt && inThisWeek(milestone.completedAt))
      .map((milestone) => ({ goalId: goal.id, goalTitle: goal.title, milestoneId: milestone.id, title: milestone.title, at: milestone.completedAt! })));
    const weeklyCheckIns = state.goals.flatMap((goal) => goal.checkIns
      .filter((checkIn) => inThisWeek(checkIn.createdAt))
      .map((checkIn) => ({ goalId: goal.id, goalTitle: goal.title, checkInId: checkIn.id, note: checkIn.note, at: checkIn.createdAt })));
    const weeklyReviews = state.reviews.filter((review) => inThisWeek(review.createdAt));
    const legacyRecords = state.timeline.filter((event) => {
      if (!["quest", "metric", "milestone", "review"].includes(event.type) || !inThisWeek(event.at)) return false;
      if (event.type === "quest") return !weeklyQuests.some((item) => completionGoalIds(item).includes(event.goalId ?? "") && nearInstant(item.completedAt, event.at));
      if (event.type === "metric") return !weeklyMetrics.some((item) => item.goalId === event.goalId && nearInstant(item.recordedAt, event.at));
      if (event.type === "milestone") return !weeklyMilestones.some((item) => item.goalId === event.goalId && nearInstant(item.at, event.at));
      return !weeklyReviews.some((item) => nearInstant(item.createdAt, event.at));
    });
    const datedRecords = [
      ...weeklyQuests.map((item) => item.completedAt),
      ...weeklyMetrics.map((item) => item.recordedAt),
      ...weeklyMilestones.map((item) => item.at),
      ...weeklyCheckIns.map((item) => item.at),
      ...weeklyReviews.map((item) => item.createdAt),
      ...legacyRecords.map((item) => item.at),
    ];
    const goalIds = new Set([
      ...weeklyQuests.flatMap(completionGoalIds),
      ...weeklyMetrics.map((item) => item.goalId),
      ...weeklyMilestones.map((item) => item.goalId),
      ...weeklyCheckIns.map((item) => item.goalId),
      ...legacyRecords.map((item) => item.goalId).filter((goalId): goalId is string => Boolean(goalId)),
    ]);

    const weeklyAreaShares = weeklyQuests.flatMap((completion) => completionAreaShares(completion, state.goals, state.timeline));
    const weeklyTimeByArea = state.areas
      .map((area) => {
        const shares = weeklyAreaShares.filter((share) => share.areaId === area.id);
        const minutes = shares.reduce((total, share) => total + share.minutes, 0);
        return { area, minutes, goalId: shares[0]?.goalId };
      })
      .filter((item) => item.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes || a.area.order - b.area.order);

    const movementByMetric = new Map<string, MetricMovement>();
    [...weeklyMetrics]
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
      .forEach((entry) => {
        const goal = state.goals.find((item) => item.id === entry.goalId);
        if (!goal) return;
        const metric = goal.metrics.find((item) => item.id === entry.metricId);
        const key = `${entry.goalId}|${entry.metricId}`;
        const label = entry.label || metric?.label || "Measurement";
        const existing = movementByMetric.get(key);
        movementByMetric.set(key, {
          key,
          goalId: goal.id,
          goalTitle: goal.title,
          label,
          unit: entry.unit ?? metric?.unit ?? "",
          from: existing?.from ?? entry.previousValue,
          to: entry.value,
          updates: (existing?.updates ?? 0) + 1,
          href: timelineHref(
            { ...weekRange, type: "metric", goalId: goal.id, query: label },
            `event-record-metric-${entry.id}`,
          ),
        });
      });
    const weeklyMetricMovements = [...movementByMetric.values()]
      .sort((left, right) => Math.abs(right.to - right.from) - Math.abs(left.to - left.from) || left.goalTitle.localeCompare(right.goalTitle));

    const weeklySourceRecords: ReviewSourceRecord[] = [
      ...weeklyQuests.map((completion) => ({
        id: `quest-${completion.id}`,
        title: completion.title,
        detail: [
          completion.durationMinutes ? `${completion.durationMinutes} minutes recorded` : "Action completion",
          completionGoalIds(completion).length > 1 ? `supports ${completionGoalIds(completion).length} ${terms.goals.toLowerCase()}` : null,
        ].filter(Boolean).join(" · "),
        at: completion.completedAt,
        goalId: completion.goalId,
        href: `/timeline#event-record-quest-${completion.id}`,
      })),
      ...weeklyMetrics.map((entry) => ({
        id: `metric-${entry.id}`,
        title: entry.label ? `${entry.label} updated` : "Measurement updated",
        detail: `${entry.previousValue.toLocaleString()} → ${entry.value.toLocaleString()}${entry.unit ? ` ${entry.unit}` : ""}`,
        at: entry.recordedAt,
        goalId: entry.goalId,
        href: `/timeline#event-record-metric-${entry.id}`,
      })),
      ...weeklyMilestones.map((milestone) => ({
        id: `milestone-${milestone.goalId}-${milestone.milestoneId}`,
        title: milestone.title,
        detail: `${milestoneTerm} reached for ${milestone.goalTitle}`,
        at: milestone.at,
        goalId: milestone.goalId,
        href: `/timeline#event-record-milestone-${milestone.goalId}-${milestone.milestoneId}`,
      })),
      ...weeklyCheckIns.map((checkIn) => ({
        id: `check-in-${checkIn.goalId}-${checkIn.checkInId}`,
        title: `Check-in for ${checkIn.goalTitle}`,
        detail: checkIn.note,
        at: checkIn.at,
        goalId: checkIn.goalId,
        href: `/timeline#event-record-check-in-${checkIn.goalId}-${checkIn.checkInId}`,
      })),
      ...legacyRecords.filter((event) => event.type !== "review").map((event) => ({
        id: `legacy-${event.id}`,
        title: event.title,
        detail: event.detail,
        at: event.at,
        goalId: event.goalId,
        href: `/timeline#event-${event.id}`,
      })),
    ].sort((left, right) => right.at.localeCompare(left.at));

    const durableRecords: Array<{
      goalId: string;
      goalIds: string[];
      statIds: string[];
      at: string;
      sourceCompletionId?: string;
    }> = [
      ...state.questCompletions.map((completion) => ({
        goalId: completion.goalId,
        goalIds: completionGoalIds(completion),
        statIds: completionStatIds(completion, state.goals, state.timeline),
        at: completion.completedAt,
        sourceCompletionId: completion.id,
      })),
      ...state.metricEntries.map((entry) => ({
        goalId: entry.goalId,
        goalIds: [entry.goalId],
        statIds: metricEntryStatIds(entry, state.goals),
        at: entry.recordedAt,
        ...(entry.sourceCompletionId ? { sourceCompletionId: entry.sourceCompletionId } : {}),
      })),
      ...state.goals.flatMap((goal) => goal.milestones
        .filter((milestone) => milestone.completedAt)
        .map((milestone) => ({
          goalId: goal.id,
          goalIds: [goal.id],
          statIds: milestone.attribution?.statIds ?? goal.statIds,
          at: milestone.completedAt!,
        }))),
      ...state.goals.flatMap((goal) => goal.checkIns.map((checkIn) => ({
        goalId: goal.id,
        goalIds: [goal.id],
        statIds: checkIn.attribution?.statIds ?? goal.statIds,
        at: checkIn.createdAt,
      }))),
    ];
    const uniqueRecords = [...durableRecords.reduce((records, record) => {
      if (!validInstant(record.at)) return records;
      const key = record.sourceCompletionId ? `completion:${record.sourceCompletionId}` : `record:${record.goalId}:${record.at}:${records.size}`;
      const existing = records.get(key);
      records.set(key, existing
        ? {
          ...existing,
          goalIds: [...new Set([...existing.goalIds, ...record.goalIds])],
          statIds: [...new Set([...existing.statIds, ...record.statIds])],
        }
        : record);
      return records;
    }, new Map<string, { goalId: string; goalIds: string[]; statIds: string[]; at: string; sourceCompletionId?: string }>()).values()];
    const inCurrentMonth = (value: string) => {
      const date = validInstant(value);
      return Boolean(date && date >= monthStart && date < tomorrow);
    };
    const inPreviousMonth = (value: string) => {
      const date = validInstant(value);
      return Boolean(date && date >= previousMonthStart && date < monthStart);
    };
    const monthlyQualityRows = state.stats
      .filter((stat) => !stat.archived)
      .map((stat) => {
        const matchingRecords = uniqueRecords.filter((record) => record.statIds.includes(stat.id));
        const current = matchingRecords.filter((record) => inCurrentMonth(record.at)).length;
        const previous = matchingRecords.filter((record) => inPreviousMonth(record.at)).length;
        const goalId = matchingRecords[0]?.goalId;
        return { stat, current, previous, goalId };
      })
      .filter((item) => item.current > 0 || item.previous > 0)
      .sort((a, b) => (b.current + b.previous) - (a.current + a.previous) || a.stat.name.localeCompare(b.stat.name));
    const monthlyComparison = {
      currentLabel: monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      previousLabel: previousMonthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      rows: [
        { label: `${terms.goals} started`, current: state.goals.filter((goal) => inCurrentMonth(goal.createdAt)).length, previous: state.goals.filter((goal) => inPreviousMonth(goal.createdAt)).length, filters: { type: "goal", query: "Created" } satisfies TimelineFilters },
        { label: `${terms.goals} completed`, current: state.goals.filter((goal) => goal.completedAt && inCurrentMonth(goal.completedAt)).length, previous: state.goals.filter((goal) => goal.completedAt && inPreviousMonth(goal.completedAt)).length, filters: { type: "goal", query: "completed" } satisfies TimelineFilters },
        { label: `${terms.milestones} reached`, current: state.goals.flatMap((goal) => goal.milestones).filter((milestone) => milestone.completedAt && inCurrentMonth(milestone.completedAt)).length, previous: state.goals.flatMap((goal) => goal.milestones).filter((milestone) => milestone.completedAt && inPreviousMonth(milestone.completedAt)).length, filters: { type: "milestone" } satisfies TimelineFilters },
        { label: "Recorded moments", current: uniqueRecords.filter((record) => inCurrentMonth(record.at)).length, previous: uniqueRecords.filter((record) => inPreviousMonth(record.at)).length, filters: { type: "activity" } satisfies TimelineFilters },
      ],
      qualityRows: monthlyQualityRows,
    };
    const monthlyLifecycle: ReviewSourceRecord[] = [
      ...state.goals.filter((goal) => inCurrentMonth(goal.createdAt)).map((goal) => ({
        id: `started-${goal.id}`,
        title: goal.title,
        detail: `${goalTerm} started`,
        at: goal.createdAt,
        goalId: goal.id,
        href: `/goals/${goal.id}`,
      })),
      ...state.goals.filter((goal) => goal.completedAt && inCurrentMonth(goal.completedAt)).map((goal) => ({
        id: `completed-${goal.id}`,
        title: goal.title,
        detail: `${goalTerm} completed`,
        at: goal.completedAt!,
        goalId: goal.id,
        href: `/timeline#event-record-goal-completed-${goal.id}`,
      })),
      ...state.goals.flatMap((goal) => goal.milestones
        .filter((milestone) => milestone.completedAt && inCurrentMonth(milestone.completedAt))
        .map((milestone) => ({
          id: `milestone-${goal.id}-${milestone.id}`,
          title: milestone.title,
          detail: `${milestoneTerm} reached for ${goal.title}`,
          at: milestone.completedAt!,
          goalId: goal.id,
          href: `/timeline#event-record-milestone-${goal.id}-${milestone.id}`,
        }))),
    ].sort((left, right) => right.at.localeCompare(left.at));

    const soon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14);
    const soonKey = localDateKey(soon);
    const quietSince = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 14);
    const goalContext = state.goals
      .filter((goal) => goal.status === "active")
      .map((goal) => {
        const questDates = state.questCompletions.filter((item) => completionGoalIds(item).includes(goal.id)).map((item) => item.completedAt);
        const metricDates = state.metricEntries.filter((item) => item.goalId === goal.id).map((item) => item.recordedAt);
        const legacyDates = state.timeline
          .filter((event) => event.goalId === goal.id && ["quest", "metric", "milestone"].includes(event.type))
          .map((event) => event.at);
        const lastActivity = latestGoalActivity(goal, [...questDates, ...legacyDates], metricDates);
        const createdAt = validInstant(goal.createdAt);
        const target = parseLocalDate(goal.targetDate);
        const targetKey = target ? localDateKey(target) : null;
        const overdue = Boolean(targetKey && targetKey < todayKey);
        const dueSoon = Boolean(targetKey && targetKey >= todayKey && targetKey <= soonKey);
        const quiet = lastActivity ? lastActivity < quietSince : Boolean(createdAt && createdAt < quietSince);
        const details = [
          overdue ? `Target date was ${formatDate(goal.targetDate)}` : dueSoon ? `Target date is ${formatDate(goal.targetDate)}` : null,
          quiet && lastActivity
            ? `Last recorded activity was ${formatDate(lastActivity.toISOString())}`
            : quiet && createdAt
              ? `No activity recorded since creation on ${formatDate(createdAt.toISOString())}`
              : null,
        ].filter((detail): detail is string => Boolean(detail));
        return { goal, details, overdue, dueSoon, quiet, lastActivity, createdAt };
      })
      .filter((item) => item.details.length)
      .sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        if (a.dueSoon !== b.dueSoon) return a.dueSoon ? -1 : 1;
        return (a.lastActivity?.getTime() ?? a.createdAt?.getTime() ?? 0) - (b.lastActivity?.getTime() ?? b.createdAt?.getTime() ?? 0);
      });

    return {
      summary: {
        activeDays: new Set(datedRecords.map((value) => validInstant(value)).filter((date): date is Date => Boolean(date)).map(localDateKey)).size,
        quests: weeklyQuests.length + legacyRecords.filter((item) => item.type === "quest").length,
        measurements: weeklyMetrics.length + legacyRecords.filter((item) => item.type === "metric").length,
        milestones: weeklyMilestones.length + legacyRecords.filter((item) => item.type === "milestone").length,
        goals: goalIds.size,
      },
      goalContext,
      weeklyMetricMovements,
      weeklySourceRecords,
      weeklyTimeByArea,
      monthlyComparison,
      monthlyLifecycle,
      weekRange,
      currentMonthRange,
      previousMonthRange,
      weekLabel: `${formatDate(localDateKey(weekStart))} – ${formatDate(todayKey)}`,
    };
  }, [goalTerm, milestoneTerm, state.areas, state.goals, state.metricEntries, state.questCompletions, state.reviews, state.stats, state.timeline, terms.goals, terms.milestones]);

  const submit = () => {
    const writtenAnswers = Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key, answer.trim()]));
    addReview({ id: uid("review"), cadence, createdAt: new Date().toISOString(), answers: writtenAnswers });
    setAnswers({});
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };
  const filled = prompts[cadence].filter((prompt) => answers[prompt.key]?.trim()).length;
  const sortedReviews = [...state.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return <div>
    <section className="page-header"><div><p className="eyebrow">Reflection without judgement</p><h1>Reviews</h1><p className="page-lead">Turn activity into understanding. Adjust your system without treating a quiet period as failure.</p></div></section>
    <div className="review-summary-grid" aria-label={`Recorded activity from ${reviewContext.weekLabel}`}>{[
      { label: "Active days this week", value: reviewContext.summary.activeDays, href: timelineHref(reviewContext.weekRange) },
      { label: "Actions completed", value: reviewContext.summary.quests, href: timelineHref({ ...reviewContext.weekRange, type: "quest" }) },
      { label: "Measurements updated", value: reviewContext.summary.measurements, href: timelineHref({ ...reviewContext.weekRange, type: "metric" }) },
      { label: `${terms.milestones} reached`, value: reviewContext.summary.milestones, href: timelineHref({ ...reviewContext.weekRange, type: "milestone" }) },
      { label: `${terms.goals} with activity`, value: reviewContext.summary.goals, href: timelineHref({ ...reviewContext.weekRange, type: "activity" }) },
    ].map((item) => <Panel key={item.label}><Link className="trace-link review-summary-link" href={item.href}><strong>{item.value}</strong><span>{item.label}</span></Link></Panel>)}</div>
    <div className="review-layout">
      <Panel className="review-form-panel">
        <div className="review-form-head"><div><p className="eyebrow">Guided reflection</p><h2>{cadence[0].toUpperCase() + cadence.slice(1)} review</h2></div><div className="cadence-switch" aria-label="Review cadence">{(["daily", "weekly", "monthly"] as ReviewCadence[]).map((item) => <button type="button" key={item} className={cadence === item ? "active" : ""} aria-pressed={cadence === item} onClick={() => { setCadence(item); setAnswers({}); }}>{item}</button>)}</div></div>
        <div className="reflection-banner"><Sparkles size={18} /><p>There are no perfect answers here. Notice what is true, useful, and kind enough to act on. This week’s summary covers {reviewContext.weekLabel}.</p></div>
        <div className="review-prompts">{prompts[cadence].map((prompt, index) => <Field key={prompt.key} label={`${index + 1}. ${prompt.label}`}><textarea rows={3} maxLength={WORKSPACE_TEXT_LIMITS.reviewAnswer} value={answers[prompt.key] ?? ""} onChange={(e) => setAnswers((current) => ({ ...current, [prompt.key]: e.target.value }))} placeholder={prompt.placeholder} /></Field>)}</div>
        <div className="review-submit"><span>{filled} of {prompts[cadence].length} reflections written</span><Button disabled={!filled} onClick={submit}>{saved ? <><Check size={16} /> Saved</> : <><BookOpenCheck size={16} /> Save reflection</>}</Button></div>
      </Panel>
      <aside className="review-history" aria-label="Review context and history">
        <Panel>
          <div className="section-heading compact"><div><p className="eyebrow">Planning context</p><h2>Dates and quiet {terms.goals.toLowerCase()}</h2></div><Clock3 size={19} /></div>
          {reviewContext.goalContext.length ? <div className="activity-list">{reviewContext.goalContext.slice(0, 6).map(({ goal, details, overdue, dueSoon }) => <div key={goal.id}><i className="area-dot" style={{ background: state.areas.find((area) => area.id === goal.areaId)?.color }} /><div><Link href={`/goals/${goal.id}`}><strong>{goal.title}</strong></Link><small>{details.join(" · ")}</small></div><b>{overdue ? "Past target" : dueSoon ? "Due soon" : "Quiet 14+ days"}</b></div>)}</div> : <p className="supportive-copy">No active {goalTerm.toLowerCase()} has a nearby or past target date, and none has been quiet for 14 days. This is planning context only; target dates and quiet periods are not judgements.</p>}
        </Panel>
        {cadence === "weekly" ? <Panel>
          <div className="section-heading compact"><div><p className="eyebrow">Measured movement</p><h2>How {terms.goals.toLowerCase()} changed this week</h2></div><CalendarCheck size={19} /></div>
          {reviewContext.weeklyMetricMovements.length ? <div className="activity-list" role="list" aria-label={`Measured ${goalTerm.toLowerCase()} movement this week`}>{reviewContext.weeklyMetricMovements.map((movement) => <div key={movement.key} role="listitem"><span className="event-dot type-metric" /><div><Link href={movement.href}><strong>{movement.label} · {movement.goalTitle}</strong></Link><small>{movement.updates} recorded {movement.updates === 1 ? "update" : "updates"}; open the underlying timeline record</small></div><b>{formatMeasurement(movement.from, movement.unit)} → {formatMeasurement(movement.to, movement.unit)}</b></div>)}</div> : <p className="supportive-copy">No measurement values changed this week. Completed actions and reflections remain available in the source records below.</p>}
        </Panel> : null}
        {cadence === "weekly" && reviewContext.weeklyTimeByArea.length ? <Panel>
          <div className="section-heading compact"><div><p className="eyebrow">Time context</p><h2>Time recorded by {areaTerm.toLowerCase()}</h2></div><Clock3 size={19} /></div>
          <div className="activity-list" role="list" aria-label={`Time recorded by life ${areaTerm.toLowerCase()} this week`}>{reviewContext.weeklyTimeByArea.map(({ area, minutes }) => <div key={area.id} role="listitem"><i className="area-dot" style={{ background: area.color }} /><div><Link className="trace-link" href={timelineHref({ ...reviewContext.weekRange, type: "quest", areaId: area.id })}><strong>{area.name}</strong></Link><small>From completion details this week</small></div><b>{formatMinutes(minutes)}</b></div>)}</div>
        </Panel> : null}
        {cadence === "weekly" && reviewContext.weeklySourceRecords.length ? <Panel>
          <div className="section-heading compact"><div><p className="eyebrow">Traceable context</p><h2>Source records this week</h2></div><BookOpenCheck size={19} /></div>
          <div className="activity-list" role="list" aria-label="Underlying records for this week's review context">{reviewContext.weeklySourceRecords.slice(0, 8).map((record) => <div key={record.id} role="listitem"><span className="event-dot type-note" /><div><Link href={record.href}><strong>{record.title}</strong></Link><small>{record.detail}</small></div><b>{formatDate(record.at)}</b></div>)}</div>
          {reviewContext.weeklySourceRecords.length > 8 ? <Link className="button button-secondary history-load-more" href={timelineHref({ ...reviewContext.weekRange, type: "activity" })}>Open all {reviewContext.weeklySourceRecords.length} source records</Link> : null}
        </Panel> : null}
        {cadence === "monthly" ? <><Panel>
          <div className="section-heading compact"><div><p className="eyebrow">Prepared comparison</p><h2>Month-to-date context</h2></div><CalendarCheck size={19} /></div>
          <p className="supportive-copy">{reviewContext.monthlyComparison.currentLabel} to date compared with the full calendar month of {reviewContext.monthlyComparison.previousLabel}. Counts are descriptive and link to connected {terms.goals.toLowerCase()} where possible.</p>
          <div className="review-comparison-chart" role="img" aria-label={`${reviewContext.monthlyComparison.currentLabel} compared with ${reviewContext.monthlyComparison.previousLabel}: ${reviewContext.monthlyComparison.rows.map((row) => `${row.label}, ${row.current} current and ${row.previous} previous`).join("; ")}`}>
            <div className="review-comparison-legend" aria-hidden="true"><span className="current">{reviewContext.monthlyComparison.currentLabel}</span><span className="previous">{reviewContext.monthlyComparison.previousLabel}</span></div>
            {reviewContext.monthlyComparison.rows.map((row) => { const maximum = Math.max(1, row.current, row.previous); return <div className="review-comparison-row" key={row.label} aria-hidden="true"><strong>{row.label}</strong><div className="review-comparison-bars"><span className="review-comparison-bar current" style={{ width: `${(row.current / maximum) * 100}%` }} /><span className="review-comparison-bar previous" style={{ width: `${(row.previous / maximum) * 100}%` }} /></div><b>{row.current} / {row.previous}</b></div>; })}
          </div>
          <div className="activity-list" role="list" aria-label={`Monthly ${goalTerm.toLowerCase()} and ${milestoneTerm.toLowerCase()} comparison`}>{reviewContext.monthlyComparison.rows.map((row) => <div key={row.label} role="listitem"><span className="event-dot type-metric" /><div><strong>{row.label}</strong><small>Select either count to inspect every matching source record</small></div><b className="review-source-counts"><Link href={timelineHref({ ...reviewContext.currentMonthRange, ...row.filters })} aria-label={`${row.current} ${row.label.toLowerCase()} in ${reviewContext.monthlyComparison.currentLabel}`}>{row.current}</Link><span aria-hidden="true"> / </span><Link href={timelineHref({ ...reviewContext.previousMonthRange, ...row.filters })} aria-label={`${row.previous} ${row.label.toLowerCase()} in ${reviewContext.monthlyComparison.previousLabel}`}>{row.previous}</Link></b></div>)}</div>
          {reviewContext.monthlyComparison.qualityRows.length ? <><div className="section-heading compact review-subheading"><div><p className="eyebrow">{terms.stats} connections</p><h3>Recorded moments</h3></div></div><div className="activity-list" role="list" aria-label={`Monthly activity by connected ${singularizeTerm(terms.stats).toLowerCase()}`}>{reviewContext.monthlyComparison.qualityRows.map(({ stat, current, previous }) => <div key={stat.id} role="listitem"><i className="area-dot" style={{ background: stat.color }} /><div><Link className="trace-link" href={timelineHref({ ...reviewContext.currentMonthRange, type: "activity", statId: stat.id })}><strong>{stat.name}</strong></Link><small>Select either count to inspect every matching source record</small></div><b className="review-source-counts"><Link href={timelineHref({ ...reviewContext.currentMonthRange, type: "activity", statId: stat.id })} aria-label={`${current} ${stat.name} records in ${reviewContext.monthlyComparison.currentLabel}`}>{current}</Link><span aria-hidden="true"> / </span><Link href={timelineHref({ ...reviewContext.previousMonthRange, type: "activity", statId: stat.id })} aria-label={`${previous} ${stat.name} records in ${reviewContext.monthlyComparison.previousLabel}`}>{previous}</Link></b></div>)}</div></> : <p className="supportive-copy">No activity connected to {terms.stats.toLowerCase()} has been recorded in either month yet.</p>}
        </Panel><Panel>
          <div className="section-heading compact"><div><p className="eyebrow">Lifecycle detail</p><h2>What started or changed state</h2></div><Clock3 size={19} /></div>
          {reviewContext.monthlyLifecycle.length ? <div className="activity-list" role="list" aria-label={`${goalTerm} and ${milestoneTerm.toLowerCase()} lifecycle changes this month`}>{reviewContext.monthlyLifecycle.map((record) => <div key={record.id} role="listitem"><span className="event-dot type-goal" /><div><Link href={record.href}><strong>{record.title}</strong></Link><small>{record.detail} · open the underlying record</small></div><b>{formatDate(record.at)}</b></div>)}</div> : <p className="supportive-copy">No {terms.goals.toLowerCase()} started or completed and no {terms.milestones.toLowerCase()} were reached this month.</p>}
        </Panel></> : null}
        <div className="section-heading compact"><div><p className="eyebrow">Permanent record</p><h2>Review history</h2></div><CalendarCheck size={19} /></div>
        {sortedReviews.length ? <>{sortedReviews.slice(0, visibleReviews).map((review) => <details key={review.id} className="review-history-card panel"><summary><span className={`review-cadence ${review.cadence}`}>{review.cadence.slice(0, 1).toUpperCase()}</span><div><strong>{review.cadence[0].toUpperCase() + review.cadence.slice(1)} review</strong><small><Clock3 size={12} /> {formatDate(review.createdAt)}</small></div><ChevronDown size={16} /></summary><div>{Object.entries(review.answers).filter(([, answer]) => answer).map(([key, answer]) => <section key={key}><small>{reviewPromptLabel(prompts, review.cadence, key)}</small><p>{answer}</p></section>)}</div></details>)}{visibleReviews < sortedReviews.length ? <button className="button button-secondary history-load-more" onClick={() => setVisibleReviews((count) => count + 12)}>Load older reviews ({sortedReviews.length - visibleReviews} remaining)</button> : null}</> : <EmptyState icon={<BookOpenCheck />} title="Your first reflection awaits" body="A review creates context around the numbers and preserves what you learned." />}
      </aside>
    </div>
  </div>;
}
