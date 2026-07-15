"use client";

import { useMemo } from "react";
import { CalendarRange } from "lucide-react";
import { useApp } from "@/components/app-provider";

export function LifeCalendar() {
  const { state } = useApp();
  const { days, age, yearProgress, activeDays } = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const start = new Date(year, 0, 1);
    const end = new Date(year + 1, 0, 1);
    const totalDays = Math.round((end.getTime() - start.getTime()) / 86400000);
    const passed = Math.floor((now.getTime() - start.getTime()) / 86400000) + 1;
    const events = state.timeline.reduce<Record<string, { count: number; type: string }>>((map, event) => {
      const key = event.at.slice(0, 10);
      map[key] = { count: (map[key]?.count ?? 0) + 1, type: event.type };
      return map;
    }, {});
    const dayList = Array.from({ length: totalDays }, (_, index) => {
      const date = new Date(start);
      date.setDate(index + 1);
      const key = date.toISOString().slice(0, 10);
      return { key, date, passed: index < passed, event: events[key] };
    });
    let years: number | null = null;
    if (state.settings.birthDate) {
      const born = new Date(`${state.settings.birthDate}T12:00:00`);
      years = year - born.getFullYear();
      if (now < new Date(year, born.getMonth(), born.getDate())) years -= 1;
    }
    return { days: dayList, age: years, yearProgress: (passed / totalDays) * 100, activeDays: Object.keys(events).length };
  }, [state.settings.birthDate, state.timeline]);

  return (
    <section className="panel life-panel">
      <div className="section-heading compact">
        <div><p className="eyebrow">Your year in motion</p><h2>{new Date().getFullYear()} life map</h2></div>
        <span className="section-icon"><CalendarRange size={19} /></span>
      </div>
      <div className="life-summary">
        <div><strong>{Math.round(yearProgress)}%</strong><span>of the year lived</span></div>
        <div><strong>{age ?? "—"}</strong><span>{age === null ? "add age in settings" : "years lived"}</span></div>
        <div><strong>{activeDays}</strong><span>days with progress</span></div>
      </div>
      <div className="calendar-scroll">
        <div className="life-grid" aria-label="Activity for every day of the current year">
          {days.map((day, index) => {
            const intensity = day.event ? Math.min(4, day.event.count) : 0;
            return <span key={`${day.key}-${index}`} className={`life-day ${day.passed ? "passed" : "future"} intensity-${intensity} type-${day.event?.type ?? "none"}`} title={`${day.date.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}${day.event ? ` · ${day.event.count} activity ${day.event.count === 1 ? "entry" : "entries"}` : ""}`} />;
          })}
        </div>
      </div>
      <div className="calendar-legend"><span>Quiet days remain part of the story</span><div><i className="intensity-1" /><i className="intensity-2" /><i className="intensity-3" /><i className="intensity-4" /></div></div>
    </section>
  );
}
