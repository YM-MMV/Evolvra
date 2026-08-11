import { Cloud, CloudOff } from "lucide-react";
import {
  shellSyncStatusLabel,
  SYNC_STATUSES,
  type SyncStatus,
} from "@/lib/provider-selectors";

export interface ProviderLifecycleStatusProps {
  authenticated: boolean;
  handoffPending?: boolean;
  erasurePending?: boolean;
  syncStatus: SyncStatus;
}

export interface ProviderLifecycleScenario extends ProviderLifecycleStatusProps {
  id: string;
  expectedLabel: string;
}

export const PROVIDER_LIFECYCLE_SCENARIOS: ProviderLifecycleScenario[] = [
  {
    id: "device-local",
    authenticated: false,
    syncStatus: "local",
    expectedLabel: "Private on this device",
  },
  {
    id: "device-saving",
    authenticated: false,
    syncStatus: "persisting",
    expectedLabel: "Saving to this device…",
  },
  ...SYNC_STATUSES.filter((status) => status !== "local" && status !== "persisting")
    .map((syncStatus): ProviderLifecycleScenario => ({
      id: `account-${syncStatus}`,
      authenticated: true,
      syncStatus,
      expectedLabel: shellSyncStatusLabel({
        authenticated: true,
        handoffPending: false,
        syncStatus,
      }),
    })),
  {
    id: "account-handoff",
    authenticated: true,
    handoffPending: true,
    syncStatus: "connecting",
    expectedLabel: "Workspace choice required",
  },
  {
    id: "account-erasure",
    authenticated: true,
    erasurePending: true,
    syncStatus: "error",
    expectedLabel: "Account erasure in progress",
  },
];

export function ProviderLifecycleStatus({
  authenticated,
  handoffPending = false,
  erasurePending = false,
  syncStatus,
}: ProviderLifecycleStatusProps) {
  const label = erasurePending
    ? "Account erasure in progress"
    : shellSyncStatusLabel({
        authenticated,
        handoffPending,
        syncStatus,
      });
  const connected = authenticated
    && !handoffPending
    && !erasurePending
    && syncStatus !== "error"
    && syncStatus !== "offline"
    && syncStatus !== "persisting";
  const Icon = connected ? Cloud : CloudOff;

  return (
    <div
      className={`sync-indicator sync-${syncStatus}`}
      data-lifecycle={erasurePending ? "erasure" : handoffPending ? "handoff" : syncStatus}
      role="status"
      aria-live="polite"
    >
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Story-like harness used by focused tests and manual component inspection. */
export function ProviderLifecycleHarness() {
  return (
    <section aria-label="Provider lifecycle states">
      {PROVIDER_LIFECYCLE_SCENARIOS.map((scenario) => (
        <article key={scenario.id} data-scenario={scenario.id}>
          <ProviderLifecycleStatus {...scenario} />
        </article>
      ))}
    </section>
  );
}
