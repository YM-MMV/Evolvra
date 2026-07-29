"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Activity, CalendarDays, CheckCircle2, Filter, Flag, Gauge, NotebookPen, Search, Sparkles, Target, X } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button, EmptyState, Panel, Pill } from "@/components/ui";
import {
  parseTimelineFilters,
  reconciledTimelineEvents,
  timelineEventMatchesFilters,
  timelineHref,
  type ReconciledTimelineEvent,
  type TimelineFilters,
} from "@/lib/timeline";
import { terminologyForms } from "@/lib/terminology";
import type { TimelineEvent } from "@/lib/types";
import { formatDate, getArea, localDateKey } from "@/lib/utils";

const eventIcons: Record<TimelineEvent["type"], React.ElementType> = {
  quest: CheckCircle2,
  milestone: Flag,
  goal: Target,
  review: NotebookPen,
  note: Sparkles,
  metric: Gauge,
};

const instant = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const filterCount = (filters: TimelineFilters) => Object.values(filters)
  .filter((value) => typeof value === "string" && value.trim()).length;

export default function TimelinePage() {
  const { state } = useApp();
  const terms = terminologyForms(state.settings.terminology);
  const eventLabels: Record<TimelineEvent["type"], string> = {
    quest: terms.quests.singularLower,
    milestone: terms.milestones.singularLower,
    goal: terms.goals.singularLower,
    review: "reflection",
    note: "note",
    metric: "measurement",
  };
  const [filters, setFilters] = useState<TimelineFilters>({});
  const [filtersReady, setFiltersReady] = useState(false);
  const [visibleCount, setVisibleCount] = useState(100);
  const reconciledEvents = useMemo(() => reconciledTimelineEvents(state), [state]);

  useEffect(() => {
    const readLocation = () => {
      setFilters(parseTimelineFilters(window.location.search));
      setVisibleCount(100);
      setFiltersReady(true);
    };
    readLocation();
    window.addEventListener("popstate", readLocation);
    return () => window.removeEventListener("popstate", readLocation);
  }, []);

  useEffect(() => {
    if (!filtersReady) return;
    const next = `${timelineHref(filters)}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(window.history.state, "", next);
  }, [filters, filtersReady]);

  const events = useMemo(
    () => reconciledEvents.filter((event) => timelineEventMatchesFilters(event, filters)),
    [filters, reconciledEvents],
  );

  useEffect(() => {
    if (!filtersReady) return;
    const revealLinkedRecord = () => {
      let fragment = "";
      try {
        fragment = decodeURIComponent(window.location.hash.replace(/^#event-/, ""));
      } catch {
        return;
      }
      if (!fragment) return;
      const linkedEvent = reconciledEvents.find((event) => event.id === fragment);
      if (!linkedEvent) return;
      if (!timelineEventMatchesFilters(linkedEvent, filters)) return;
      const index = events.findIndex((event) => event.id === fragment);
      if (index < 0) return;
      setVisibleCount((count) => Math.max(count, index + 1));
      window.requestAnimationFrame(() => {
        const target = document.getElementById(`event-${fragment}`);
        target?.scrollIntoView({ block: "center" });
        target?.focus({ preventScroll: true });
      });
    };
    revealLinkedRecord();
    window.addEventListener("hashchange", revealLinkedRecord);
    return () => window.removeEventListener("hashchange", revealLinkedRecord);
  }, [events, filters, filtersReady, reconciledEvents]);

  const visibleEvents = events.slice(0, visibleCount);
  const grouped = visibleEvents.reduce<Record<string, ReconciledTimelineEvent[]>>((groups, event) => {
    const date = instant(event.at);
    if (!date) return groups;
    const key = date.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    groups[key] = [...(groups[key] ?? []), event];
    return groups;
  }, {});
  const actionCount = events.filter((event) => event.type === "quest").length;
  const activeDays = new Set(events
    .map((event) => instant(event.at))
    .filter((date): date is Date => Boolean(date))
    .map(localDateKey)).size;
  const activeFilters = filterCount(filters);
  const invalidRange = Boolean(filters.from && filters.to && filters.from > filters.to);

  const updateFilter = <Key extends keyof TimelineFilters>(key: Key, value: TimelineFilters[Key]) => {
    setVisibleCount(100);
    setFilters((current) => {
      const next = { ...current, [key]: value };
      if (typeof value !== "string" || !value.trim()) delete next[key];
      return next;
    });
  };
  const clearFilters = () => {
    setVisibleCount(100);
    setFilters({});
  };

  return <div>
    <section className="page-header"><div><p className="eyebrow">Your permanent record</p><h1>Timeline</h1><p className="page-lead">A reconciled chronological account of completed {terms.quests.pluralLower}, measurements, {terms.milestones.pluralLower}, check-ins, reflections, and {terms.goals.singularLower} changes.</p></div></section>
    <div className="timeline-stats">
      <Panel><Activity /><div><strong>{events.length}</strong><span>{activeFilters ? "matching records" : "recorded entries"}</span></div></Panel>
      <Panel><CheckCircle2 /><div><strong>{actionCount}</strong><span>matching {actionCount === 1 ? terms.quests.singularLower : terms.quests.pluralLower}</span></div></Panel>
      <Panel><CalendarDays /><div><strong>{activeDays}</strong><span>local calendar days</span></div></Panel>
    </div>
    <div className="toolbar panel timeline-filter-toolbar">
      <div className="search-box"><Search size={17} /><input value={filters.query ?? ""} onChange={(event) => updateFilter("query", event.target.value)} placeholder="Search your history…" aria-label="Search timeline" /></div>
      <label className="select-with-icon"><Filter size={15} aria-hidden="true" /><select value={filters.type ?? "all"} onChange={(event) => updateFilter("type", event.target.value === "all" ? undefined : event.target.value as TimelineFilters["type"])} aria-label="Filter timeline by event type"><option value="all">Every entry</option><option value="activity">Recorded moments</option><option value="quest">Completed {terms.quests.pluralLower}</option><option value="milestone">{terms.milestones.plural}</option><option value="goal">{terms.goals.singular} changes</option><option value="review">Reflections</option><option value="metric">Measurements</option><option value="note">Notes and check-ins</option></select></label>
      <select value={filters.areaId ?? ""} onChange={(event) => updateFilter("areaId", event.target.value || undefined)} aria-label={`Filter timeline by life ${terms.areas.singularLower}`}><option value="">Every {terms.areas.singularLower}</option>{state.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select>
      <select value={filters.statId ?? ""} onChange={(event) => updateFilter("statId", event.target.value || undefined)} aria-label={`Filter timeline by ${terms.stats.singularLower}`}><option value="">Every {terms.stats.singularLower}</option>{state.stats.map((stat) => <option key={stat.id} value={stat.id}>{stat.name}</option>)}</select>
      <select value={filters.goalId ?? ""} onChange={(event) => updateFilter("goalId", event.target.value || undefined)} aria-label={`Filter timeline by ${terms.goals.singularLower}`}><option value="">Every {terms.goals.singularLower}</option>{state.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select>
      <label className="timeline-date-filter"><span>From</span><input type="date" value={filters.from ?? ""} onChange={(event) => updateFilter("from", event.target.value || undefined)} /></label>
      <label className="timeline-date-filter"><span>To</span><input type="date" value={filters.to ?? ""} onChange={(event) => updateFilter("to", event.target.value || undefined)} /></label>
      {activeFilters ? <Button variant="ghost" onClick={clearFilters}><X size={15} /> Clear {activeFilters} {activeFilters === 1 ? "filter" : "filters"}</Button> : null}
    </div>
    {invalidRange ? <div className="system-alert" role="alert">The start date must be on or before the end date.</div> : null}
    {!events.length ? <EmptyState icon={<Activity />} title="No matching records" body="Adjust or clear the filters to inspect the source records behind your summaries." /> : <><div className="timeline-groups">{Object.entries(grouped).map(([month, monthEvents]) => <section key={month}><div className="timeline-month"><span>{month}</span><i /></div><div className="timeline-list">{monthEvents.map((event) => {
      const Icon = eventIcons[event.type];
      const area = getArea(state, event.areaId);
      const date = instant(event.at)!;
      const goalExists = event.goalId && state.goals.some((goal) => goal.id === event.goalId);
      const additionalGoals = (event.relatedGoalIds ?? [])
        .filter((goalId) => goalId !== event.goalId)
        .flatMap((goalId) => {
          const relatedGoal = state.goals.find((goal) => goal.id === goalId);
          return relatedGoal ? [relatedGoal] : [];
        });
      return <article id={`event-${event.id}`} tabIndex={-1} key={event.id} className="timeline-event"><div className={`timeline-icon type-${event.type}`} aria-hidden="true"><Icon size={17} /></div><div className="timeline-copy"><div><strong>{event.title}</strong><Pill>{eventLabels[event.type]}</Pill></div><p>{event.detail}</p><small><time dateTime={event.at}>{formatDate(event.at)} · {date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</time>{area && <> · <span style={{ color: area.color }}>{area.name}</span></>}{additionalGoals.length ? <> · Also supports {additionalGoals.map((goal, index) => <span key={goal.id}>{index ? ", " : ""}<Link href={`/goals/${goal.id}`}>{goal.title}</Link></span>)}</> : null}</small></div>{goalExists && <Link className="timeline-primary-link" href={`/goals/${event.goalId}`} aria-label={`Open primary ${terms.goals.singularLower} for ${event.title}`}>Open {terms.goals.singularLower} <span aria-hidden="true">→</span></Link>}</article>;
    })}</div></section>)}</div>{visibleEvents.length < events.length && <div className="button-row end"><button className="button button-secondary" onClick={() => setVisibleCount((count) => count + 100)}>Load 100 older entries <span aria-hidden="true">({events.length - visibleEvents.length} remaining)</span></button></div>}</>}
  </div>;
}
