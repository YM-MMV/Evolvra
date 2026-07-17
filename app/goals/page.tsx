"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Columns3, Goal as GoalIcon, LayoutGrid, List, Plus, Search } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { GoalForm } from "@/components/goal-form";
import { GoalCard } from "@/components/goal-card";
import { Button, EmptyState, Pill, ProgressBar } from "@/components/ui";
import type { GoalStatus } from "@/lib/types";
import { getArea, goalProgress, shortDate } from "@/lib/utils";

type View = "cards" | "list" | "board";

function GoalsContent() {
  const { state } = useApp();
  const searchParams = useSearchParams();
  const [formOpen, setFormOpen] = useState(searchParams.get("new") === "true");
  const [view, setView] = useState<View>("list");
  const [status, setStatus] = useState<GoalStatus | "all">("active");
  const [area, setArea] = useState("all");
  const [query, setQuery] = useState("");

  const goals = useMemo(() => state.goals.filter((goal) => {
    return (status === "all" || goal.status === status) && (area === "all" || goal.areaId === area) && (!query || `${goal.title} ${goal.description}`.toLowerCase().includes(query.toLowerCase()));
  }), [area, query, state.goals, status]);

  return <div>
    <section className="page-header"><div><p className="eyebrow">Outcomes over activity</p><h1>Your {state.settings.terminology.goals.toLowerCase()}</h1><p className="page-lead">Define what matters, choose an honest measurement, and always know the next useful action.</p></div><Button onClick={() => setFormOpen(true)}><Plus size={17} /> New {state.settings.terminology.goals.replace(/s$/i, "").toLowerCase()}</Button></section>

    <div className="toolbar panel">
      <div className="search-box"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search goals…" /></div>
      <select value={status} onChange={(e) => setStatus(e.target.value as GoalStatus | "all")}><option value="all">Every status</option><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option><option value="archived">Archived</option></select>
      <select value={area} onChange={(e) => setArea(e.target.value)}><option value="all">Every area</option>{state.areas.filter((item) => !item.archived).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <div className="view-switcher"><button className={view === "cards" ? "active" : ""} onClick={() => setView("cards")} aria-label="Card view" aria-pressed={view === "cards"}><LayoutGrid size={17} /></button><button className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-label="List view" aria-pressed={view === "list"}><List size={18} /></button><button className={view === "board" ? "active" : ""} onClick={() => setView("board")} aria-label="Board view" aria-pressed={view === "board"}><Columns3 size={17} /></button></div>
    </div>

    {!goals.length ? <EmptyState icon={<GoalIcon />} title="No goals in this view" body="Adjust the filters or create an outcome that deserves your attention." action={<Button onClick={() => setFormOpen(true)}>Create a goal</Button>} /> : view === "cards" ? <div className="goal-grid goals-page-grid">{goals.map((goal) => <GoalCard key={goal.id} goal={goal} area={getArea(state, goal.areaId)} />)}</div> : view === "list" ? <div className="goal-table panel">{goals.map((goal) => { const goalArea = getArea(state, goal.areaId); const progress = goalProgress(goal); return <a href={`/goals/${goal.id}`} key={goal.id} className="goal-table-row"><span className="area-dot" style={{ background: goalArea?.color }} /><div className="goal-table-title"><strong>{goal.title}</strong><small>{goalArea?.name}</small></div><Pill>{goal.priority}</Pill><div className="goal-table-progress"><span>{progress === null ? "Reflective" : `${Math.round(progress)}%`}</span>{progress !== null && <ProgressBar value={progress} color={goalArea?.color} />}</div><span className="goal-date">{shortDate(goal.targetDate) || "Open"}</span></a>; })}</div> : <div className="goal-board">{(["active", "paused", "completed"] as GoalStatus[]).map((column) => <section key={column}><header><h3>{column}</h3><span>{goals.filter((goal) => goal.status === column).length}</span></header><div>{goals.filter((goal) => goal.status === column).map((goal) => <GoalCard key={goal.id} goal={goal} area={getArea(state, goal.areaId)} />)}</div></section>)}</div>}
    <GoalForm open={formOpen} onClose={() => setFormOpen(false)} />
  </div>;
}

export default function GoalsPage() {
  return <Suspense fallback={null}><GoalsContent /></Suspense>;
}
