import { describe, expect, it } from "vitest";
import { LEGACY_LAST_REMINDER_KEY, reminderStorageKey } from "@/lib/reminders";

describe("account-scoped reminder metadata", () => {
  it("gives anonymous and connected workspaces distinct keys", () => {
    expect(reminderStorageKey("anonymous")).toBe(`${LEGACY_LAST_REMINDER_KEY}:anonymous`);
    expect(reminderStorageKey("account-a")).toBe(`${LEGACY_LAST_REMINDER_KEY}:account-a`);
    expect(reminderStorageKey("account-a")).not.toBe(reminderStorageKey("account-b"));
  });

  it("encodes arbitrary account identifiers and refuses an unscoped key", () => {
    expect(reminderStorageKey("account/with spaces")).toBe(
      `${LEGACY_LAST_REMINDER_KEY}:account%2Fwith%20spaces`,
    );
    expect(() => reminderStorageKey("")).toThrow(/account scope/i);
  });
});
