"use client";

import { useState } from "react";
import type { MetricEntry, ProgressMetric } from "@/lib/types";
import { formatDate } from "@/lib/utils";

export function MetricHistoryChart({ metric, entries, color }: { metric: ProgressMetric; entries: MetricEntry[]; color?: string }) {
  const [visibleCount, setVisibleCount] = useState(30);
  const sortedEntries = [...entries].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  const data = sortedEntries
    .slice(-visibleCount)
    .map((entry) => ({ label: formatDate(entry.recordedAt), value: entry.value }));
  if (data.length < 2) return null;
  const summary = data.map((item) => `${item.label}: ${item.value} ${metric.unit}`).join(", ");
  const chart = { width: 720, height: 190, left: 52, right: 14, top: 12, bottom: 24 };
  const maximum = Math.max(1, ...data.map((item) => item.value));
  const ticks = [...new Set([maximum, Math.round(maximum / 2), 0])];
  const x = (index: number) => chart.left
    + index * ((chart.width - chart.left - chart.right) / (data.length - 1));
  const y = (value: number) => chart.top
    + (chart.height - chart.top - chart.bottom) * (1 - (value / maximum));
  const points = data.map((item, index) => `${x(index)},${y(item.value)}`).join(" ");

  return (
    <section className="metric-history-block">
      <div><strong>{metric.label} history</strong><small>Last {data.length} recorded changes</small></div>
      <div className="metric-history-chart" role="img" aria-label={`${metric.label} recorded history. ${summary}`}>
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} aria-hidden="true" focusable="false">
          {ticks.map((value) => <g key={value}><line x1={chart.left} x2={chart.width - chart.right} y1={y(value)} y2={y(value)} stroke="var(--line)" /><text x={chart.left - 8} y={y(value) + 4} textAnchor="end" fill="var(--muted)" fontSize="10">{value.toLocaleString()}</text></g>)}
          <polyline points={points} fill="none" stroke={color ?? "var(--accent)"} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          {data.map((item, index) => <circle key={`${item.label}-${index}`} cx={x(index)} cy={y(item.value)} r="3" fill={color ?? "var(--accent)"}><title>{item.label}: {item.value.toLocaleString()} {metric.unit}</title></circle>)}
          <text x={chart.left} y={chart.height - 5} fill="var(--muted)" fontSize="10">{data[0].label}</text>
          <text x={chart.width - chart.right} y={chart.height - 5} textAnchor="end" fill="var(--muted)" fontSize="10">{data.at(-1)!.label}</text>
        </svg>
      </div>
      {data.length < sortedEntries.length ? <button className="button button-secondary history-load-more" onClick={() => setVisibleCount((count) => count + 30)}>Load older {metric.label} records ({sortedEntries.length - data.length} remaining)</button> : null}
    </section>
  );
}
