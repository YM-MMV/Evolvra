import { describe, expect, it } from "vitest";
import { reviewPromptLabel, reviewPromptsFor } from "@/lib/review-prompts";

describe("review terminology", () => {
  it("uses configured concept names in prompts and retained answer labels", () => {
    const prompts = reviewPromptsFor({
      goals: "Missions",
      quests: "Actions",
      areas: "Realms",
      milestones: "Chapters",
      stats: "Attributes",
    });

    expect(prompts.weekly[0].label).toBe("Where did my missions move?");
    expect(prompts.weekly[1].label).toBe("Which attributes did I develop?");
    expect(prompts.monthly[0].placeholder).toContain("missions, realms");
    expect(prompts.monthly[1].label).toBe("Which chapters or moments mattered?");
    expect(prompts.daily[1].placeholder).toContain("chapter");
    expect(reviewPromptLabel(prompts, "weekly", "movement")).toBe("Where did my missions move?");
  });
});
