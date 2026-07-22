import type { ReviewCadence, Terminology } from "@/lib/types";
import { singularizeTerm } from "@/lib/utils";

export type ReviewPrompt = { key: string; label: string; placeholder: string };

/** Build every configurable product term at render time, including history labels. */
export function reviewPromptsFor(terms: Terminology): Record<ReviewCadence, ReviewPrompt[]> {
  const goals = terms.goals.toLowerCase();
  const areas = terms.areas.toLowerCase();
  const milestones = terms.milestones.toLowerCase();
  const stats = terms.stats.toLowerCase();
  const milestone = singularizeTerm(terms.milestones).toLowerCase();

  return {
    daily: [
      { key: "worked", label: "What did I work on?", placeholder: "The actions, sessions, or decisions that received attention…" },
      { key: "progressed", label: "What genuinely progressed?", placeholder: `A measurement, understanding, ${milestone}, or relationship that changed…` },
      { key: "blocked", label: "Is anything blocking me?", placeholder: "Name friction without judging yourself…" },
      { key: "next", label: "What should I focus on next?", placeholder: "One useful next action is enough…" },
    ],
    weekly: [
      { key: "movement", label: `Where did my ${goals} move?`, placeholder: "Notice real movement and quiet maintenance…" },
      { key: "developed", label: `Which ${stats} did I develop?`, placeholder: "Knowledge, discipline, health, communication…" },
      { key: "meaning", label: "What was most meaningful?", placeholder: "It does not need to be the biggest event…" },
      { key: "adjust", label: "What needs adjustment?", placeholder: "Pause, resize, simplify, or re-sequence anything…" },
      { key: "priorities", label: "What deserves priority next week?", placeholder: "Choose direction without overloading the week…" },
    ],
    monthly: [
      { key: "progress", label: "What major progress became visible?", placeholder: `Look across ${goals}, ${areas}, and everyday life…` },
      { key: "milestones", label: `Which ${milestones} or moments mattered?`, placeholder: `${terms.milestones}, decisions, habits, and evidence…` },
      { key: "growth", label: "How did I develop?", placeholder: "What can you do, understand, or handle now?" },
      { key: "patterns", label: "What long-term patterns do I notice?", placeholder: "Energy, focus, environment, trade-offs…" },
      { key: "direction", label: "What direction feels right now?", placeholder: "Continue, change, pause, or begin…" },
    ],
  };
}

export function reviewPromptLabel(
  prompts: Record<ReviewCadence, ReviewPrompt[]>,
  cadence: ReviewCadence,
  key: string,
) {
  return prompts[cadence].find((item) => item.key === key)?.label ?? key;
}
