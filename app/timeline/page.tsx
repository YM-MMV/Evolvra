"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Activity, CalendarDays, CheckCircle2, Filter, Flag, Gauge, NotebookPen, Search, Sparkles, Target, Trophy } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { EmptyState, Panel, Pill } from "@/components/ui";
import type { TimelineEvent } from "@/lib/types";
import { formatDate, getArea } from "@/lib/utils";

const eventIcons: Record<TimelineEvent["type"], React.ElementType> = { quest: CheckCircle2, milestone: Flag, goal: Target, level: Trophy, review: NotebookPen, note: Sparkles, metric: Gauge };

export default function TimelinePage() {
  const { state } = useApp();
  const [type, setType] = useState<TimelineEvent["type"] | "all">("all");
  const [areaId, setAreaId] = useState("all");
  const [query, setQuery] = useState("");
  const events = useMemo(() => state.timeline.filter((event) => (type === "all" || event.type === type) && (areaId === "all" || event.areaId === areaId) && (!query || `${event.title} ${event.detail}`.toLowerCase().includes(query.toLowerCase()))), [areaId, query, state.timeline, type]);
  const grouped = events.reduce<Record<string, TimelineEvent[]>>((groups, event) => { const key = new Date(event.at).toLocaleDateString("en-GB", { month: "long", year: "numeric" }); groups[key] = [...(groups[key] ?? []), event]; return groups; }, {});

  return <div>
    <section className="page-header"><div><p className="eyebrow">Your development record</p><h1>Timeline</h1><p className="page-lead">A chronological account of actions, milestones, decisions, reflections, and growth.</p></div></section>
    <div className="timeline-stats"><Panel><Activity /><div><strong>{state.timeline.length}</strong><span>recorded moments</span></div></Panel><Panel><Trophy /><div><strong>{state.timeline.filter((event) => event.type === "level").length}</strong><span>level-up moments</span></div></Panel><Panel><CalendarDays /><div><strong>{new Set(state.timeline.map((event) => event.at.slice(0, 10))).size}</strong><span>days with progress</span></div></Panel></div>
    <div className="toolbar panel"><div className="search-box"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your history…" /></div><label className="select-with-icon"><Filter size={15} /><select value={type} onChange={(e) => setType(e.target.value as TimelineEvent["type"] | "all")}><option value="all">Every event</option><option value="quest">Quests</option><option value="milestone">Milestones</option><option value="goal">Goal changes</option><option value="level">Level-ups</option><option value="review">Reviews</option><option value="metric">Metrics</option><option value="note">Notes</option></select></label><select value={areaId} onChange={(e) => setAreaId(e.target.value)}><option value="all">Every area</option>{state.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></div>
    {!events.length ? <EmptyState icon={<Activity />} title="No matching moments" body="Your record grows whenever you complete, reflect, update, or change direction." /> : <div className="timeline-groups">{Object.entries(grouped).map(([month, monthEvents]) => <section key={month}><div className="timeline-month"><span>{month}</span><i /></div><div className="timeline-list">{monthEvents.map((event) => { const Icon = eventIcons[event.type]; const area = getArea(state, event.areaId); return <article key={event.id} className="timeline-event"><div className={`timeline-icon type-${event.type}`}><Icon size={17} /></div><div className="timeline-copy"><div><strong>{event.title}</strong><Pill>{event.type}</Pill></div><p>{event.detail}</p><small>{formatDate(event.at)} · {new Date(event.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}{area && <> · <span style={{ color: area.color }}>{area.name}</span></>}</small></div>{event.xp && <div className="timeline-xp">+{event.xp}<small>XP</small></div>}{event.goalId && <Link href={`/goals/${event.goalId}`} aria-label="Open goal">→</Link>}</article>; })}</div></section>)}</div>}
  </div>;
}
