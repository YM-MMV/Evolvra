"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, Check, CheckCircle2, Circle, Filter, Plus, Repeat2, Search } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { EmptyState, Panel, Pill } from "@/components/ui";
import { formatDate, getArea } from "@/lib/utils";

type QuestView = "available" | "completed" | "all";

export default function QuestsPage() {
  const { state, completeQuest } = useApp();
  const [view, setView] = useState<QuestView>("available");
  const [areaId, setAreaId] = useState("all");
  const [query, setQuery] = useState("");

  const quests = useMemo(() => state.goals.flatMap((goal) => goal.quests.map((quest) => ({ quest, goal }))).filter(({ quest, goal }) => {
    const stateMatch = view === "all" || (view === "completed" ? quest.completed : !quest.completed);
    const areaMatch = areaId === "all" || goal.areaId === areaId;
    const searchMatch = !query || `${quest.title} ${goal.title}`.toLowerCase().includes(query.toLowerCase());
    return stateMatch && areaMatch && searchMatch;
  }).sort((a, b) => Number(a.quest.completed) - Number(b.quest.completed) || (a.quest.dueDate ?? "9999").localeCompare(b.quest.dueDate ?? "9999")), [areaId, query, state.goals, view]);

  const grouped = quests.reduce<Record<string, typeof quests>>((groups, item) => {
    const key = item.quest.completed ? "Completed" : item.quest.dueDate && item.quest.dueDate <= new Date().toISOString().slice(0, 10) ? "Today & overdue" : item.quest.dueDate ? "Upcoming" : "Anytime";
    groups[key] = [...(groups[key] ?? []), item];
    return groups;
  }, {});

  return <div>
    <section className="page-header"><div><p className="eyebrow">Actions with purpose</p><h1>{state.settings.terminology.quests} board</h1><p className="page-lead">Choose actions that move a real goal. Missing a day never destroys your progress.</p></div><Link href="/goals" className="button button-primary"><Plus size={17} /> Add through a goal</Link></section>
    <div className="toolbar panel"><div className="search-box"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search quests…" /></div><div className="filter-tabs"><button className={view === "available" ? "active" : ""} onClick={() => setView("available")}>Available</button><button className={view === "completed" ? "active" : ""} onClick={() => setView("completed")}>Completed</button><button className={view === "all" ? "active" : ""} onClick={() => setView("all")}>All</button></div><label className="select-with-icon"><Filter size={15} /><select value={areaId} onChange={(e) => setAreaId(e.target.value)}><option value="all">Every area</option>{state.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label></div>
    {!quests.length ? <EmptyState icon={<CheckCircle2 />} title="No quests in this view" body="A clear list can be a sign of focus. Add the next useful action when you are ready." /> : <div className="quest-groups">{["Today & overdue", "Upcoming", "Anytime", "Completed"].filter((group) => grouped[group]).map((group) => <section key={group}><div className="section-heading compact"><div><p className="eyebrow">{group}</p><h2>{group === "Completed" ? "Recorded actions" : `${group} quests`}</h2></div><span className="count-badge">{grouped[group].length}</span></div><Panel className="quest-board-list">{grouped[group].map(({ quest, goal }) => { const area = getArea(state, goal.areaId); return <div key={`${goal.id}-${quest.id}`} className={quest.completed ? "quest-board-row completed" : "quest-board-row"}><button className="quest-check large" onClick={() => completeQuest(goal.id, quest.id)} disabled={quest.completed}>{quest.completed ? <Check size={18} /> : <Circle size={19} />}</button><div className="quest-board-copy"><strong>{quest.title}</strong><Link href={`/goals/${goal.id}`}><i style={{ background: area?.color }} />{goal.title}</Link></div><div className="quest-tags">{quest.repeat !== "none" && <Pill><Repeat2 size={12} /> {quest.repeat}</Pill>}{quest.dueDate && <Pill><CalendarDays size={12} /> {formatDate(quest.dueDate)}</Pill>}</div><div className="quest-xp"><strong>+{quest.xp}</strong><small>XP</small></div></div>; })}</Panel></section>)}</div>}
  </div>;
}
