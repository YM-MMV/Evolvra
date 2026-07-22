"use client";

import { useReportWebVitals } from "next/web-vitals";
import { reportPrivacySafeTelemetry } from "@/lib/client-telemetry";

export function WebVitals() {
  useReportWebVitals((metric) => {
    const safeMetric = { kind: "web-vital", name: metric.name, value: metric.value, rating: metric.rating };
    reportPrivacySafeTelemetry(safeMetric);
    if (process.env.NODE_ENV === "development") console.info("[Evolvra web vital]", safeMetric);
  });
  return null;
}
