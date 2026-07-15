"use client";

import Link from "next/link";
import { ArrowUpRight, CalendarDays, Flag, PauseCircle } from "lucide-react";
import { DynamicIcon } from "@/components/icons";
import { ProgressBar, Pill } from "@/components/ui";
import type { Area, Goal } from "@/lib/types";
import { goalProgress, shortDate } from "@/lib/utils";

export function GoalCard({ goal, area }: { goal: Goal; area?: Area }) {
  const progress = goalProgress(goal);
  const nextMilestone = goal.milestones.find((milestone) => !milestone.completed);
  const nextQuest = goal.quests.find((quest) => !quest.completed);
  return (
    <Link href={`/goals/${goal.id}`} className="goal-card panel">
      <div className="goal-card-top">
        <span className="area-icon" style={{ color: area?.color, background: `${area?.color}18` }}><DynamicIcon name={area?.icon ?? "Target"} /></span>
        <span className="goal-arrow"><ArrowUpRight size={18} /></span>
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
        <small>{nextMilestone ? "Next milestone" : nextQuest ? "Next action" : "Goal state"}</small>
        <span>{nextMilestone?.title ?? nextQuest?.title ?? "Ready for review"}</span>
      </div>
      <div className="goal-card-meta">
        <Pill color={goal.priority === "critical" ? "#ff718a" : goal.priority === "high" ? "#f4b65e" : undefined}><Flag size={12} /> {goal.priority}</Pill>
        {goal.status === "paused" && <Pill><PauseCircle size={12} /> Paused</Pill>}
        {goal.targetDate && <span><CalendarDays size={13} /> {shortDate(goal.targetDate)}</span>}
      </div>
    </Link>
  );
}
