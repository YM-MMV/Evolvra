export interface QualityHistoryMoment {
  at: string;
  statIds: readonly string[];
}

export interface QualityHistorySeriesRow {
  key: string;
  label: string;
  from: Date;
  to: Date;
  counts: Record<string, number>;
}

const bucketCountFor = (windowDays: number) => {
  if (windowDays <= 30) return 6;
  if (windowDays <= 90) return 9;
  return 12;
};

const calendarBoundary = (start: Date, offset: number) => {
  const boundary = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  boundary.setDate(boundary.getDate() + offset);
  return boundary;
};

const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * Groups immutable activity records into local-calendar buckets. A record linked
 * to the same quality more than once still contributes only one count.
 */
export const buildQualityActivitySeries = (
  moments: readonly QualityHistoryMoment[],
  statIds: readonly string[],
  start: Date,
  windowDays: number,
): QualityHistorySeriesRow[] => {
  const bucketCount = bucketCountFor(windowDays);
  const knownStats = new Set(statIds);
  const rows = Array.from({ length: bucketCount }, (_, index) => {
    const fromOffset = Math.round((windowDays * index) / bucketCount);
    const toOffset = Math.round((windowDays * (index + 1)) / bucketCount);
    const from = calendarBoundary(start, fromOffset);
    const to = calendarBoundary(start, toOffset);
    return {
      key: `${from.getFullYear()}-${from.getMonth() + 1}-${from.getDate()}`,
      label: shortDate.format(from),
      from,
      to,
      counts: Object.fromEntries(statIds.map((statId) => [statId, 0])),
    };
  });

  for (const moment of moments) {
    const at = new Date(moment.at);
    if (Number.isNaN(at.getTime())) continue;
    const row = rows.find((candidate) => at >= candidate.from && at < candidate.to);
    if (!row) continue;
    for (const statId of new Set(moment.statIds)) {
      if (knownStats.has(statId)) row.counts[statId] += 1;
    }
  }

  return rows;
};
