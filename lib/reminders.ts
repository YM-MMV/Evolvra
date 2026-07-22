export const LEGACY_LAST_REMINDER_KEY = "evolvra:reminder:last-delivered";

/** Keeps local reminder delivery metadata isolated to one persisted workspace. */
export function reminderStorageKey(accountId: string) {
  if (!accountId) throw new Error("Reminder storage requires an account scope.");
  return `evolvra:reminder:last-delivered:${encodeURIComponent(accountId)}`;
}
