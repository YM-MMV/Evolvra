"use client";

import { useMemo } from "react";
import Link from "next/link";
import { CalendarRange } from "lucide-react";
import { useApp } from "@/components/app-provider";
import {
  completionAttribution,
  goalCompletionAttribution,
  metricEntryStatIds,
} from "@/lib/activity-attribution";
import { timelineHref } from "@/lib/timeline";
import type { AppState } from "@/lib/types";
import { localDateKey, parseLocalDate } from "@/lib/utils";

export interface ActivityMoment {
  id: string;
  at: string;
  type: "quest" | "metric" | "milestone" | "check-in" | "review" | "goal";
  goalId?: string;
  goalIds: string[];
  areaIds: string[];
  statIds: string[];
}

/**
 * Build the activity picture from durable domain records instead of the display
 * timeline. Quest-generated metric changes are excluded because the quest
 * completion already represents that action.
 */
export function collectActivityMoments(state: AppState): ActivityMoment[] {
  const moments: ActivityMoment[] = [
    ...state.questCompletions.map((completion) => {
      const attribution = completionAttribution(completion, state.goals, state.timeline);
      return {
        id: `quest:${completion.id}`,
        at: completion.completedAt,
        type: "quest" as const,
        goalId: completion.goalId,
        ...attribution,
      };
    }),
    ...state.metricEntries.filter((entry) => entry.source === "manual").map((entry) => ({
      id: `metric:${entry.id}`,
      at: entry.recordedAt,
      type: "metric" as const,
      goalId: entry.goalId,
      goalIds: [entry.goalId],
      areaIds: entry.attribution?.areaId
        ? [entry.attribution.areaId]
        : state.goals.find((goal) => goal.id === entry.goalId)?.areaId
          ? [state.goals.find((goal) => goal.id === entry.goalId)!.areaId]
          : [],
      statIds: metricEntryStatIds(entry, state.goals),
    })),
    ...state.goals.flatMap((goal) => [
      ...goal.milestones.flatMap((milestone) => milestone.completedAt ? [{
        id: `milestone:${goal.id}:${milestone.id}`,
        at: milestone.completedAt,
        type: "milestone" as const,
        goalId: goal.id,
        goalIds: [goal.id],
        areaIds: [milestone.attribution?.areaId ?? goal.areaId],
        statIds: milestone.attribution?.statIds ?? goal.statIds,
      }] : []),
      ...goal.checkIns.map((checkIn) => ({
        id: `check-in:${goal.id}:${checkIn.id}`,
        at: checkIn.createdAt,
        type: "check-in" as const,
        goalId: goal.id,
        goalIds: [goal.id],
        areaIds: [checkIn.attribution?.areaId ?? goal.areaId],
        statIds: checkIn.attribution?.statIds ?? goal.statIds,
      })),
      ...(goal.completedAt ? [{
        id: `goal:${goal.id}`,
        at: goal.completedAt,
        type: "goal" as const,
        goalId: goal.id,
        ...goalCompletionAttribution(goal, state.timeline),
      }] : []),
    ]),
    ...state.reviews.map((review) => ({
      id: `review:${review.id}`,
      at: review.createdAt,
      type: "review" as const,
      goalIds: [],
      areaIds: [],
      statIds: [],
    })),
  ];

  return moments.filter((moment) => parseLocalDate(moment.at));
}

export function LifeCalendar() {
  const { state } = useApp();
  const { days, age, year, yearProgress, activeDays } = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentYear = now.getFullYear();
    const end = new Date(currentYear + 1, 0, 1);
    const events = collectActivityMoments(state).reduce<Record<string, { count: number; type: ActivityMoment["type"] }>>((map, moment) => {
      const parsed = parseLocalDate(moment.at);
      if (!parsed || parsed.getFullYear() !== currentYear) return map;
      const key = localDateKey(parsed);
      map[key] = { count: (map[key]?.count ?? 0) + 1, type: map[key]?.type ?? moment.type };
      return map;
    }, {});

    const dayList: Array<{ key: string; date: Date; passed: boolean; event?: { count: number; type: ActivityMoment["type"] } }> = [];
    for (const cursor = new Date(currentYear, 0, 1); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
      const date = new Date(cursor);
      const key = localDateKey(date);
      dayList.push({ key, date, passed: date <= today, event: events[key] });
    }

    let years: number | null = null;
    const born = parseLocalDate(state.settings.birthDate);
    if (born && born <= today) {
      years = currentYear - born.getFullYear();
      if (today < new Date(currentYear, born.getMonth(), born.getDate())) years -= 1;
    }

    const passedDays = dayList.filter((day) => day.passed).length;
    return {
      days: dayList,
      age: years,
      year: currentYear,
      yearProgress: (passedDays / dayList.length) * 100,
      activeDays: Object.keys(events).length,
    };
  }, [state]);
  const yearRange = { from: `${year}-01-01`, to: `${year}-12-31` };

  return (
    <section className="panel life-panel">
      <div className="section-heading compact">
        <div><p className="eyebrow">Your year in motion</p><h2>{year} life map</h2></div>
        <span className="section-icon" aria-hidden="true"><CalendarRange size={19} /></span>
      </div>
      <div className="life-summary">
        <div><strong>{Math.round(yearProgress)}%</strong><span>of the year lived</span></div>
        <Link href="/settings" aria-label={age === null ? "Add birth date in settings" : "Review birth date in settings"}><strong>{age ?? "—"}</strong><span>{age === null ? "add age in settings" : "years lived"}</span></Link>
        <Link href={timelineHref({ ...yearRange, type: "activity" })} aria-label={`Inspect ${activeDays} active days in ${year}`}><strong>{activeDays}</strong><span>days with recorded activity</span></Link>
      </div>
      <div className="calendar-scroll">
        <div
          className="life-grid"
          role="img"
          aria-label={`${year} activity calendar: ${activeDays} ${activeDays === 1 ? "day" : "days"} with recorded activity`}
        >
          {days.map((day) => {
            const intensity = day.event ? Math.min(4, day.event.count) : 0;
            const activityLabel = day.event ? ` · ${day.event.count} recorded ${day.event.count === 1 ? "moment" : "moments"}` : "";
            return <time key={day.key} dateTime={day.key} aria-hidden="true" className={`life-day ${day.passed ? "passed" : "future"} intensity-${intensity} type-${day.event?.type ?? "none"}`} title={`${day.date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}${activityLabel}`} />;
          })}
        </div>
      </div>
      <div className="calendar-legend"><Link className="trace-link" href={timelineHref({ ...yearRange, type: "activity" })}>Inspect this year&apos;s source records</Link><div aria-hidden="true"><i className="intensity-1" /><i className="intensity-2" /><i className="intensity-3" /><i className="intensity-4" /></div></div>
    </section>
  );
}
