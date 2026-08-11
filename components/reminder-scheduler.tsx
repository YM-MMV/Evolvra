"use client";

import { useEffect, useRef } from "react";
import {
  useAppActions,
  useProviderStatus,
  useWorkspaceData,
} from "@/components/app-provider";
import {
  readAccountReminderDate,
  writeAccountReminderDate,
} from "@/lib/persistence";
import { LEGACY_LAST_REMINDER_KEY, reminderStorageKey } from "@/lib/reminders";
import { persistenceAccountId } from "@/lib/sync-reconciliation";
import { terminologyForms } from "@/lib/terminology";
import { isQuestAvailable, localDateKey } from "@/lib/utils";

/**
 * Browser reminders are deliberately local and privacy-safe. They run while the
 * installed app or a browser tab is active; no activity data is sent to a server.
 */
export function ReminderScheduler() {
  const {
    state,
    workspaceScopeKey,
    persistenceScopeGeneration,
  } = useWorkspaceData();
  const { user, workspaceSwitching } = useProviderStatus();
  const {
    runWorkspaceFileOperation,
    reportPersistenceError,
  } = useAppActions();
  const accountId = persistenceAccountId(user?.id ?? null);
  const storageKey = reminderStorageKey(accountId);
  const persistenceIdentity = `${storageKey}:${persistenceScopeGeneration}`;
  const lastDelivered = useRef<{ identity: string; dateKey: string | null } | null>(null);

  useEffect(() => {
    if (workspaceSwitching || !state.settings.notifications || !state.settings.reminderTime || typeof Notification === "undefined") return;
    let cancelled = false;
    const operationScopeKey = workspaceScopeKey;

    const check = async () => {
      try {
        await runWorkspaceFileOperation(operationScopeKey, async () => {
          if (cancelled || Notification.permission !== "granted") return;
          const now = new Date();
          const dateKey = localDateKey(now);
          if (!lastDelivered.current || lastDelivered.current.identity !== persistenceIdentity) {
            let storedDateKey = await readAccountReminderDate(accountId);
            if (cancelled) return;
            // Move legacy localStorage metadata into the generation-fenced IDB
            // record once. From this point onward IDB is authoritative.
            try {
              const legacyAccountDate = localStorage.getItem(storageKey);
              const legacyAnonymousDate = accountId === persistenceAccountId(null)
                ? localStorage.getItem(LEGACY_LAST_REMINDER_KEY)
                : null;
              const legacyDate = legacyAccountDate ?? legacyAnonymousDate;
              if (!storedDateKey && legacyDate) {
                await writeAccountReminderDate(
                  accountId,
                  persistenceScopeGeneration,
                  legacyDate,
                );
                storedDateKey = legacyDate;
              }
            } catch (error) {
              reportPersistenceError(error instanceof Error
                ? `Legacy reminder metadata could not be migrated safely: ${error.message}`
                : "Legacy reminder metadata could not be migrated safely.");
            }
            try {
              localStorage.removeItem(storageKey);
            } catch (error) {
              reportPersistenceError(error instanceof Error
                ? `The legacy account reminder marker could not be removed: ${error.message}`
                : "The legacy account reminder marker could not be removed.");
            }
            if (accountId === persistenceAccountId(null)) {
              try {
                localStorage.removeItem(LEGACY_LAST_REMINDER_KEY);
              } catch (error) {
                // The historical anonymous marker is unscoped. Retaining it
                // must be visible rather than silently reported as complete.
                reportPersistenceError(error instanceof Error
                  ? `The legacy anonymous reminder marker could not be removed: ${error.message}`
                  : "The legacy anonymous reminder marker could not be removed.");
              }
            }
            lastDelivered.current = { identity: persistenceIdentity, dateKey: storedDateKey };
          }
          if (cancelled || lastDelivered.current.dateKey === dateKey) return;
          const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          if (currentTime < state.settings.reminderTime!) return;
          const readyActions = state.goals
            .filter((goal) => goal.status === "active")
            .flatMap((goal) => goal.quests)
            .filter((quest) => isQuestAvailable(quest, now)).length;
          if (!readyActions) return;

          const questTerms = terminologyForms(state.settings.terminology).quests;
          const options: NotificationOptions = {
            body: `${readyActions} ${readyActions === 1 ? `${questTerms.singularLower} is` : `${questTerms.pluralLower} are`} ready when you are.`,
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            tag: `evolvra-reminder-${dateKey}`,
          };
          try {
            const registration = await navigator.serviceWorker?.ready;
            if (cancelled) return;
            if (registration) await registration.showNotification("A calm Evolvra check-in", options);
            else new Notification("A calm Evolvra check-in", options);
            if (cancelled) return;
            lastDelivered.current = { identity: persistenceIdentity, dateKey };
            await writeAccountReminderDate(
              accountId,
              persistenceScopeGeneration,
              dateKey,
            );
          } catch {
            // Permission or platform state can change between the check and delivery.
          }
        });
      } catch {
        // A scope change or terminal account barrier deliberately cancels this check.
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accountId, persistenceIdentity, persistenceScopeGeneration, reportPersistenceError, runWorkspaceFileOperation, state.goals, state.settings.notifications, state.settings.reminderTime, state.settings.terminology, storageKey, workspaceScopeKey, workspaceSwitching]);

  return null;
}
