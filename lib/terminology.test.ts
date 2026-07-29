import { describe, expect, it } from "vitest";
import { terminologyForms } from "@/lib/terminology";

describe("terminologyForms", () => {
  it("provides consistent display forms for every configurable domain noun", () => {
    expect(terminologyForms({
      goals: "Missions",
      quests: "Rituals",
      areas: "Realms",
      milestones: "Chapters",
      stats: "Attributes",
    })).toEqual({
      goals: {
        plural: "Missions",
        singular: "Mission",
        pluralLower: "missions",
        singularLower: "mission",
      },
      quests: {
        plural: "Rituals",
        singular: "Ritual",
        pluralLower: "rituals",
        singularLower: "ritual",
      },
      areas: {
        plural: "Realms",
        singular: "Realm",
        pluralLower: "realms",
        singularLower: "realm",
      },
      milestones: {
        plural: "Chapters",
        singular: "Chapter",
        pluralLower: "chapters",
        singularLower: "chapter",
      },
      stats: {
        plural: "Attributes",
        singular: "Attribute",
        pluralLower: "attributes",
        singularLower: "attribute",
      },
    });
  });

  it("trims labels before deriving their display forms", () => {
    expect(terminologyForms({
      goals: "  Focus  ",
      quests: " Practice ",
      areas: " Context ",
      milestones: " Progress ",
      stats: " Growth ",
    }).goals).toEqual({
      plural: "Focus",
      singular: "Focus",
      pluralLower: "focus",
      singularLower: "focus",
    });
  });
});
