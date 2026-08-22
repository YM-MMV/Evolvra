"use client";

import Link from "next/link";
import { ArrowUpRight, CalendarDays, Flag } from "lucide-react";
import { useWorkspaceData } from "@/components/app-provider";
import { DynamicIcon } from "@/components/icons";
import { ProgressBar, Pill } from "@/components/ui";
import { terminologyForms } from "@/lib/terminology";
import type { Area, Goal } from "@/lib/types";
import { goalProgress, isQuestAvailable, shortDate } from "@/lib/utils";

export function GoalCard({
  goal,
  area,
  variant = "card",
}: {
  goal: Goal;
  area?: Area;
  variant?: "card" | "readout";
}) {
  const { state } = useWorkspaceData();
  const terms = terminologyForms(state.settings.terminology);
  const progress = goalProgress(goal);
  const active = goal.status === "active";
  const nextMilestone = active ? goal.milestones.find((milestone) => !milestone.completed) : undefined;
  const nextQuest = active ? goal.quests.find((quest) => isQuestAvailable(quest)) : undefined;
  const nextScheduledQuest = active ? goal.quests
    .filter((quest) => quest.repeat !== "none" || !quest.completed)
    .filter((quest) => !isQuestAvailable(quest))
    .sort((a, b) => (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31"))[0] : undefined;
  const nextLabel = nextMilestone
    ? `Next ${terms.milestones.singularLower}`
    : nextQuest
      ? `Next ${terms.quests.singularLower}`
      : nextScheduledQuest
        ? `Next scheduled ${terms.quests.singularLower}`
        : `${terms.goals.singular} status`;
  const nextValue = goal.status === "completed"
    ? `Completed${goal.completedAt ? ` ${shortDate(goal.completedAt)}` : ""}`
    : goal.status === "archived"
      ? "Archived for reference"
      : goal.status === "paused"
        ? "Paused until you are ready"
        : nextMilestone?.title ?? nextQuest?.title ?? nextScheduledQuest?.title ?? "Ready for review";
  const goalHref = `/goals/${goal.id}`;
  const goalLabel = `Open ${terms.goals.singularLower}: ${goal.title}`;

  if (variant === "readout") {
    return (
      <Link href={goalHref} className="goal-readout" aria-label={goalLabel}>
        <div className="goal-readout-copy">
          <span className="area-label" style={{ color: area?.color }}>{area?.name ?? "Unassigned"}</span>
          <h3>{goal.title}</h3>
          <p>{goal.description}</p>
        </div>
        <div className="goal-readout-progress">
          <div className="progress-label">
            <span>{progress === null ? "Reflective progress" : `${Math.round(progress)}% complete`}</span>
            <strong>{goal.model}</strong>
          </div>
          {progress === null
            ? <div className="reflection-line"><span /><span /><span /></div>
            : <ProgressBar value={progress} color={area?.color} />}
          <span className="goal-readout-priority">
            <Flag size={12} aria-hidden="true" />
            {goal.priority}
          </span>
        </div>
        <div className="goal-readout-next">
          <small>{nextLabel}</small>
          <strong>{nextValue}</strong>
          {goal.targetDate && <time dateTime={goal.targetDate}>{shortDate(goal.targetDate)}</time>}
        </div>
      </Link>
    );
  }

  return (
    <Link href={goalHref} className="goal-card panel" aria-label={goalLabel}>
      <div className="goal-card-top">
        <span className="area-icon" style={{ color: area?.color, background: `${area?.color}18` }} aria-hidden="true"><DynamicIcon name={area?.icon ?? "Target"} /></span>
        <span className="goal-arrow" aria-hidden="true"><ArrowUpRight size={18} /></span>
      </div>
      <div className="goal-card-copy">
        <span className="area-label" style={{ color: area?.color }}>{area?.name ?? "Unassigned"}</span>
        <h3>{goal.title}</h3>
        <p>{goal.description}</p>
      </div>
      <div className="goal-card-progress">
        <div className="progress-label"><span>{progress === null ? "Reflective progress" : `${Math.round(progress)}% complete`}</span><strong>{goal.model}</strong></div>
        {progress === null ? <div className="reflection-line"><span /> <span /> <span /></div> : <ProgressBar value={progress} color={area?.color} />}
      </div>
      <div className="goal-next">
        <small>{nextLabel}</small>
        <span>{nextValue}</span>
      </div>
      <div className="goal-card-meta">
        <Pill color={goal.priority === "critical" ? "#df4444" : goal.priority === "high" ? "#ffc15c" : undefined}><Flag size={12} aria-hidden="true" /> {goal.priority}</Pill>
        {goal.status !== "active" && <Pill>{goal.status}</Pill>}
        {goal.targetDate && <span><CalendarDays size={13} aria-hidden="true" /> <time dateTime={goal.targetDate}>{shortDate(goal.targetDate)}</time></span>}
      </div>
    </Link>
  );
}
