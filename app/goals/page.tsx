"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Columns3, Goal as GoalIcon, LayoutGrid, List, Plus, Search } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { GoalForm } from "@/components/goal-form";
import { GoalCard } from "@/components/goal-card";
import { Button, EmptyState, Pill, ProgressBar } from "@/components/ui";
import type { GoalStatus } from "@/lib/types";
import { getArea, goalProgress, shortDate, singularizeTerm } from "@/lib/utils";

type View = "cards" | "list" | "board";

const boardColumns: GoalStatus[] = ["active", "paused", "completed"];

function GoalsContent() {
  const { state } = useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [formOpen, setFormOpen] = useState(false);
  const [view, setView] = useState<View>("list");
  const [status, setStatus] = useState<GoalStatus | "all">("active");
  const [area, setArea] = useState("all");
  const [query, setQuery] = useState("");
  const terms = state.settings.terminology;
  const goalTerm = singularizeTerm(terms.goals);
  const areaTerm = singularizeTerm(terms.areas);
  const formRequestedByUrl = searchParams.get("new") === "true";

  const closeGoalForm = () => {
    setFormOpen(false);
    if (searchParams.get("new") !== "true") return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("new");
    router.replace(nextParams.size ? `/goals?${nextParams.toString()}` : "/goals", { scroll: false });
  };

  const matchingGoals = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return state.goals.filter((goal) => {
      const areaMatch = area === "all" || goal.areaId === area;
      const searchMatch = !normalizedQuery || `${goal.title} ${goal.description}`.toLowerCase().includes(normalizedQuery);
      return areaMatch && searchMatch;
    });
  }, [area, query, state.goals]);

  const filteredGoals = useMemo(
    () => matchingGoals.filter((goal) => status === "all" || goal.status === status),
    [matchingGoals, status],
  );

  return (
    <div>
      <section className="page-header">
        <div>
          <p className="eyebrow">Outcomes over activity</p>
          <h1>Your {state.settings.terminology.goals.toLowerCase()}</h1>
          <p className="page-lead">Define what matters, choose an honest measurement, and always know the next useful action.</p>
        </div>
        <Button type="button" onClick={() => setFormOpen(true)}><Plus size={17} aria-hidden="true" /> New {goalTerm.toLowerCase()}</Button>
      </section>

      <div className="toolbar panel">
        <div className="search-box"><Search size={17} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${terms.goals.toLowerCase()}…`} aria-label={`Search ${terms.goals.toLowerCase()}`} /></div>
        <select
          value={view === "board" ? "all" : status}
          onChange={(event) => setStatus(event.target.value as GoalStatus | "all")}
          disabled={view === "board"}
          aria-label={`Filter ${terms.goals.toLowerCase()} by status`}
          title={view === "board" ? `Board view shows every ${goalTerm.toLowerCase()} status` : `Filter ${terms.goals.toLowerCase()} by status`}
        >
          <option value="all">Every status</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
        <select value={area} onChange={(event) => setArea(event.target.value)} aria-label={`Filter ${terms.goals.toLowerCase()} by ${areaTerm.toLowerCase()}`}>
          <option value="all">Every {areaTerm.toLowerCase()}</option>
          {state.areas.filter((item) => !item.archived).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <div className="view-switcher" role="group" aria-label={`${goalTerm} layout`}>
          <button type="button" className={view === "cards" ? "active" : ""} onClick={() => setView("cards")} aria-label="Card view" aria-pressed={view === "cards"}><LayoutGrid size={17} aria-hidden="true" /></button>
          <button type="button" className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-label="List view" aria-pressed={view === "list"}><List size={18} aria-hidden="true" /></button>
          <button type="button" className={view === "board" ? "active" : ""} onClick={() => setView("board")} aria-label="Board view" aria-pressed={view === "board"}><Columns3 size={17} aria-hidden="true" /></button>
        </div>
      </div>

      {view === "board" ? (
        <div className="goal-board" aria-label={`${terms.goals} grouped by workflow status`}>
          {boardColumns.map((column) => {
            const columnGoals = matchingGoals.filter((goal) => goal.status === column);
            const headingId = `goal-column-${column}`;
            return (
              <section key={column} aria-labelledby={headingId}>
                <header><h3 id={headingId}>{column}</h3><span aria-label={`${columnGoals.length} ${column} ${terms.goals.toLowerCase()}`}>{columnGoals.length}</span></header>
                <div>
                  {columnGoals.map((goal) => <GoalCard key={goal.id} goal={goal} area={getArea(state, goal.areaId)} />)}
                  {!columnGoals.length && <p className="supportive-copy">No {column} {terms.goals.toLowerCase()} match these filters.</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : !filteredGoals.length ? (
        <EmptyState
          icon={<GoalIcon />}
          title={`No ${terms.goals.toLowerCase()} in this view`}
          body="Adjust the filters or create an outcome that deserves your attention."
          action={<Button type="button" onClick={() => setFormOpen(true)}>Create a {goalTerm.toLowerCase()}</Button>}
        />
      ) : view === "cards" ? (
        <div className="goal-grid goals-page-grid">{filteredGoals.map((goal) => <GoalCard key={goal.id} goal={goal} area={getArea(state, goal.areaId)} />)}</div>
      ) : (
        <div className="goal-table panel" aria-label={`${terms.goals} list`}>
          {filteredGoals.map((goal) => {
            const goalArea = getArea(state, goal.areaId);
            const progress = goalProgress(goal);
            return (
              <Link href={`/goals/${goal.id}`} key={goal.id} className="goal-table-row" aria-label={`Open ${goalTerm.toLowerCase()}: ${goal.title}`}>
                <span className="area-dot" style={{ background: goalArea?.color }} aria-hidden="true" />
                <div className="goal-table-title"><strong>{goal.title}</strong><small>{goalArea?.name ?? "Unassigned"} · {goal.status}</small></div>
                <Pill>{goal.priority}</Pill>
                <div className="goal-table-progress">
                  <span>{progress === null ? "Reflective" : `${Math.round(progress)}%`}</span>
                  {progress !== null && <ProgressBar value={progress} color={goalArea?.color} label={`${goal.title} progress`} />}
                </div>
                <span className="goal-date">{goal.targetDate ? <time dateTime={goal.targetDate}>{shortDate(goal.targetDate)}</time> : "Open"}</span>
              </Link>
            );
          })}
        </div>
      )}
      <GoalForm open={formOpen || formRequestedByUrl} onClose={closeGoalForm} />
    </div>
  );
}

export default function GoalsPage() {
  return <Suspense fallback={<p role="status">Loading workspace…</p>}><GoalsContent /></Suspense>;
}
