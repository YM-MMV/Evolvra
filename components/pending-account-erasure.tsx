"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui";
import {
  abandonExpiredFinalizingAccountErasure,
  accountErasureCheckpointNeedsRecovery,
  actionableLocalErasureCheckpoint,
  advanceCloudAccountErasure,
  discardCorruptAccountErasureCheckpoint,
  eraseInactiveAccountLocalData,
  finalizingErasureLeaseExpired,
  LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY,
  listAccountErasureCheckpoints,
  migrateLegacyAccountErasureCheckpoints,
  parseLegacyAccountErasureCheckpoints,
  prepareAmbiguousAccountErasureRetry,
  recoverOrphanedAccountErasureIntent,
  resumeLocalAccountErasure,
  safelyDiscardLegacyAccountErasureCheckpoints,
  subscribeToAccountErasureChanges,
  type AccountErasureCheckpoint,
} from "@/lib/account-erasure";
import {
  listTombstonedAccountPersistenceScopes,
  privacySafeWorkspaceExport,
  readRawWorkspace,
  recoverWorkspaceEnvelope,
} from "@/lib/persistence";
import { eraseConnectedAccount, getSupabase } from "@/lib/supabase";
import { ANONYMOUS_ACCOUNT_ID } from "@/lib/sync-reconciliation";

const INITIATOR_GRACE_MS = 2_000;
export const ANONYMOUS_ERASURE_FENCE_BLOCKED_MESSAGE =
  "The anonymous workspace has an unexpected permanent account-deletion fence. Automatic repair is disabled because it cannot safely restore writable anonymous storage; contact support before using this browser again.";

export function hasAnonymousAccountErasureTombstone(
  scopes: Array<{ accountId: string; tombstoned: boolean }>,
): boolean {
  return scopes.some((scope) =>
    scope.accountId === ANONYMOUS_ACCOUNT_ID && scope.tombstoned);
}

export function selectAccountErasureRecoveryCheckpoint(
  checkpoints: AccountErasureCheckpoint[],
  authenticatedAccountId: string | null | undefined,
  terminalErasureAccountId: string | null,
): AccountErasureCheckpoint | null {
  const exactTerminalCheckpoint = authenticatedAccountId
    && terminalErasureAccountId === authenticatedAccountId
    ? checkpoints.find((item) => item.accountId === authenticatedAccountId)
    : null;
  return exactTerminalCheckpoint
    ?? actionableLocalErasureCheckpoint(checkpoints)
    ?? checkpoints.find((item) => (
      item.accountId === authenticatedAccountId
      && accountErasureCheckpointNeedsRecovery(item)
    ))
    ?? checkpoints.find(accountErasureCheckpointNeedsRecovery)
    ?? null;
}

export function exactAccountProvesAmbiguousDeletionFailed(
  checkpoint: AccountErasureCheckpoint,
  authenticatedAccountId: string | null | undefined,
): boolean {
  return checkpoint.cloud === "ambiguous"
    && checkpoint.local === "complete"
    && checkpoint.session === "complete"
    && authenticatedAccountId === checkpoint.accountId;
}

export function shouldFinalizeCompletedTerminalAccount(
  checkpoint: AccountErasureCheckpoint,
  authenticatedAccountId: string | null | undefined,
  terminalErasureAccountId: string | null,
): boolean {
  return checkpoint.cloud === "complete"
    && checkpoint.local === "complete"
    && authenticatedAccountId === checkpoint.accountId
    && terminalErasureAccountId === checkpoint.accountId;
}

/**
 * Runs before AppProvider mounts. No workspace can hydrate until old deletion
 * bookkeeping is either migrated behind IDB tombstones or explicitly rejected.
 */
export function AccountErasureBootstrapGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [needsExplicitRepair, setNeedsExplicitRepair] = useState(false);
  const [repairBlocked, setRepairBlocked] = useState(false);
  const [retryEpoch, setRetryEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const inspect = async () => {
      setWorking(true);
      setFailure(null);
      setNeedsExplicitRepair(false);
      setRepairBlocked(false);
      try {
        let tombstonedScopes = await listTombstonedAccountPersistenceScopes();
        if (hasAnonymousAccountErasureTombstone(tombstonedScopes)) {
          if (cancelled) return;
          setWorking(false);
          setRepairBlocked(true);
          setFailure(ANONYMOUS_ERASURE_FENCE_BLOCKED_MESSAGE);
          return;
        }
        const legacyRaw = window.localStorage.getItem(
          LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY,
        );
        if (legacyRaw !== null) {
          try {
            parseLegacyAccountErasureCheckpoints(JSON.parse(legacyRaw));
          } catch (error) {
            if (cancelled) return;
            setWorking(false);
            setNeedsExplicitRepair(true);
            setFailure(error instanceof Error
              ? `A legacy account-cleanup record is damaged and was not trusted: ${error.message}`
              : "A legacy account-cleanup record is damaged and was not trusted.");
            return;
          }
          await migrateLegacyAccountErasureCheckpoints(window.localStorage);
        }

        let inventory = await listAccountErasureCheckpoints();
        const supabase = getSupabase();
        const getAuthenticatedAccountId = async () => {
          if (!supabase) return null;
          const { data, error } = await supabase.auth.getSession();
          if (error) throw error;
          return data.session?.user.id ?? null;
        };
        const clearExactAccountSession = async (targetAccountId: string) => {
          if (!supabase) return null;
          if (await getAuthenticatedAccountId() !== targetAccountId) return null;
          const { error } = await supabase.auth.signOut({ scope: "local" });
          return error
            ? "The exact account's device data was erased, but its expired browser session could not be cleared. Close this tab before another person uses the browser."
            : null;
        };
        // Complete every already-authorized local/session cleanup before the
        // provider can hydrate any workspace. No provider writer exists yet,
        // and the permanent generation tombstone protects every direct erase.
        for (const checkpoint of inventory.checkpoints.filter((item) => (
          (item.cloud === "complete" || item.cloud === "ambiguous")
          && (item.local === "pending" || item.session === "pending")
        ))) {
          const result = await resumeLocalAccountErasure({
            checkpoint,
            workspaceSwitching: false,
            getAuthenticatedAccountId,
            eraseInactiveAccount: (target) => eraseInactiveAccountLocalData(
              target,
              window.localStorage,
            ),
            clearExactAccountSession,
          });
          if (result.sessionWarning) throw new Error(result.sessionWarning);
        }
        inventory = await listAccountErasureCheckpoints();
        const knownAccounts = new Set(inventory.checkpoints.map((item) => item.accountId));
        tombstonedScopes = await listTombstonedAccountPersistenceScopes();
        if (hasAnonymousAccountErasureTombstone(tombstonedScopes)) {
          if (cancelled) return;
          setWorking(false);
          setNeedsExplicitRepair(false);
          setRepairBlocked(true);
          setFailure(ANONYMOUS_ERASURE_FENCE_BLOCKED_MESSAGE);
          return;
        }
        const orphanTombstones = tombstonedScopes
          .filter((scope) => !knownAccounts.has(scope.accountId));
        if (inventory.corrupt.length || orphanTombstones.length) {
          if (cancelled) return;
          setWorking(false);
          setNeedsExplicitRepair(true);
          setFailure(inventory.corrupt.length
            ? "A damaged durable account-cleanup record was isolated. Its permanent account fence remains intact."
            : "A permanent account-deletion fence was found without readable recovery bookkeeping.");
          return;
        }
        if (cancelled) return;
        setReady(true);
        setWorking(false);
      } catch (error) {
        if (cancelled) return;
        setWorking(false);
        setNeedsExplicitRepair(false);
        setRepairBlocked(false);
        setFailure(error instanceof Error
          ? error.message
          : "Account-cleanup safety checks could not finish before workspace startup.");
      }
    };
    void inspect();
    return () => { cancelled = true; };
  }, [retryEpoch]);

  const repairAndRestart = async () => {
    setWorking(true);
    setFailure(null);
    setRepairBlocked(false);
    try {
      let tombstonedScopes = await listTombstonedAccountPersistenceScopes();
      if (hasAnonymousAccountErasureTombstone(tombstonedScopes)) {
        setWorking(false);
        setNeedsExplicitRepair(false);
        setRepairBlocked(true);
        setFailure(ANONYMOUS_ERASURE_FENCE_BLOCKED_MESSAGE);
        return;
      }
      // The click is the explicit consent boundary. Unreadable legacy
      // bookkeeping is discarded only after shared legacy bytes are permanently
      // disabled and removed; tombstones and current IndexedDB workspaces stay.
      const legacyRaw = window.localStorage.getItem(
        LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY,
      );
      if (legacyRaw !== null) {
        try {
          parseLegacyAccountErasureCheckpoints(JSON.parse(legacyRaw));
        } catch {
          await safelyDiscardLegacyAccountErasureCheckpoints(window.localStorage);
        }
      }
      const inventory = await listAccountErasureCheckpoints();
      for (const corrupt of inventory.corrupt) {
        await discardCorruptAccountErasureCheckpoint(corrupt.key);
      }
      const remaining = await listAccountErasureCheckpoints();
      const knownAccounts = new Set(remaining.checkpoints.map((item) => item.accountId));
      tombstonedScopes = await listTombstonedAccountPersistenceScopes();
      if (hasAnonymousAccountErasureTombstone(tombstonedScopes)) {
        setWorking(false);
        setNeedsExplicitRepair(false);
        setRepairBlocked(true);
        setFailure(ANONYMOUS_ERASURE_FENCE_BLOCKED_MESSAGE);
        return;
      }
      for (const scope of tombstonedScopes) {
        if (knownAccounts.has(scope.accountId)) continue;
        await recoverOrphanedAccountErasureIntent(scope.accountId, scope.generation);
      }
      setRetryEpoch((value) => value + 1);
    } catch (error) {
      setWorking(false);
      setRepairBlocked(false);
      setFailure(error instanceof Error
        ? error.message
        : "The fenced account cleanup could not be restarted safely.");
    }
  };

  if (ready) return children;
  return (
    <div
      className="loading-screen"
      role={failure ? "alertdialog" : "status"}
      aria-live="polite"
    >
      <span className="brand-mark"><ShieldCheck /></span>
      <div style={{ width: "min(560px, calc(100vw - 40px))", textAlign: "center" }}>
        <h1 style={{ fontSize: "clamp(24px, 5vw, 34px)" }}>
          {failure ? "Account cleanup must be resolved first" : "Checking private recovery state…"}
        </h1>
        <p>{failure ?? "Evolvra is verifying account-deletion fences before opening any workspace."}</p>
        {failure && !repairBlocked && (
          <div className="button-row" style={{ justifyContent: "center", marginTop: 22 }}>
            <Button
              variant={needsExplicitRepair ? "danger" : "primary"}
              disabled={working}
              onClick={() => {
                if (needsExplicitRepair) void repairAndRestart();
                else setRetryEpoch((value) => value + 1);
              }}
            >
              {working
                ? "Checking…"
                : needsExplicitRepair
                  ? "Discard damaged record and restart fenced cleanup"
                  : "Retry safety check"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function PendingAccountErasureRecovery() {
  const {
    ready,
    user,
    workspaceSwitching,
    terminalErasureAccountId,
    adoptActiveAccountErasure,
    finishActiveAccountErasure,
    signIn,
  } = useApp();
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [cloudRetryRequested, setCloudRetryRequested] = useState(false);
  const [abandonRequested, setAbandonRequested] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [retryNeedsCloud, setRetryNeedsCloud] = useState(false);
  const [retryNeedsAbandon, setRetryNeedsAbandon] = useState(false);
  const [exportAccountId, setExportAccountId] = useState<string | null>(null);
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [authPending, setAuthPending] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const attemptedCheckpoint = useRef("");
  const operationInFlight = useRef(false);

  useEffect(() => subscribeToAccountErasureChanges(() => {
    if (operationInFlight.current) return;
    attemptedCheckpoint.current = "";
    setRetryEpoch((value) => value + 1);
  }), []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let retryTimer: number | undefined;

    const scheduleRetry = (delay: number) => {
      retryTimer = window.setTimeout(() => {
        attemptedCheckpoint.current = "";
        setRetryEpoch((value) => value + 1);
      }, Math.max(1, delay));
    };

    const recover = async () => {
      await Promise.resolve();
      if (cancelled) return;
      let checkpoint: AccountErasureCheckpoint | null = null;
      try {
        const inventory = await listAccountErasureCheckpoints();
        if (cancelled) return;
        if (inventory.corrupt.length) {
          setWorking(false);
          setRetryNeedsCloud(false);
          setRetryNeedsAbandon(false);
          setExportAccountId(null);
          setFailure("A damaged account-cleanup checkpoint was isolated. Open Evolvra support or clear that exact corrupt recovery record before using this shared browser again.");
          return;
        }
        checkpoint = selectAccountErasureRecoveryCheckpoint(
          inventory.checkpoints,
          user?.id,
          terminalErasureAccountId,
        );
      } catch (error) {
        setWorking(false);
        setRetryNeedsCloud(false);
        setRetryNeedsAbandon(false);
        setExportAccountId(null);
        setFailure(error instanceof Error
          ? error.message
          : "A pending account cleanup could not be read safely.");
        return;
      }

      if (!checkpoint) {
        setWorking(false);
        setFailure(null);
        setRetryNeedsCloud(false);
        setRetryNeedsAbandon(false);
        setExportAccountId(null);
        setCloudRetryRequested(false);
        return;
      }

      const signature = `${checkpoint.accountId}:${checkpoint.attemptId}:${checkpoint.cloud}:${checkpoint.local}:${checkpoint.session}:${checkpoint.updatedAt}:${user?.id ?? "signed-out"}:${retryEpoch}`;
      if (attemptedCheckpoint.current === signature) return;
      attemptedCheckpoint.current = signature;
      setWorking(true);
      setFailure(null);
      setRetryNeedsCloud(false);
      setRetryNeedsAbandon(false);
      setExportAccountId(null);

      // Let the tab that just created or advanced the checkpoint finish its
      // own call first. A recovered older checkpoint skips this grace period.
      const checkpointAge = Date.now() - Date.parse(checkpoint.updatedAt);
      if (Number.isFinite(checkpointAge) && checkpointAge < INITIATOR_GRACE_MS) {
        scheduleRetry(INITIATOR_GRACE_MS - checkpointAge);
        return;
      }

      operationInFlight.current = true;
      try {
        const supabase = getSupabase();
        const getAuthenticatedAccountId = async () => {
          if (!supabase) return user?.id ?? null;
          const { data, error } = await supabase.auth.getSession();
          if (error) throw error;
          return data.session?.user.id ?? null;
        };
        const clearExactAccountSession = async (targetAccountId: string) => {
          if (!supabase) {
            return "The account data was erased, but this tab could not clear its expired sign-in session; close this tab before another person uses the browser.";
          }
          if (await getAuthenticatedAccountId() !== targetAccountId) return null;
          const { error } = await supabase.auth.signOut({ scope: "local" });
          return error
            ? "The account data was erased, but this tab could not clear its expired sign-in session; close this tab before another person uses the browser."
            : null;
        };
        let terminalFenced = terminalErasureAccountId === checkpoint.accountId;
        if (user?.id === checkpoint.accountId) {
          await adoptActiveAccountErasure(
            checkpoint.accountId,
            checkpoint.persistenceGeneration,
          );
          terminalFenced = true;
        }

        if (checkpoint.cloud === "finalizing") {
          if (!finalizingErasureLeaseExpired(checkpoint)) {
            const leaseRemaining = Date.parse(checkpoint.owner!.leaseExpiresAt) - Date.now();
            scheduleRetry(leaseRemaining);
            return;
          }
          if (!abandonRequested) {
            setWorking(false);
            setRetryNeedsAbandon(true);
            setFailure("The final cloud response was lost and its recovery lease expired. Confirm that Evolvra should treat the outcome as uncertain and continue exact-account device cleanup.");
            return;
          }
          checkpoint = await abandonExpiredFinalizingAccountErasure(
            checkpoint.accountId,
            checkpoint.attemptId,
          );
        }

        if (exactAccountProvesAmbiguousDeletionFailed(checkpoint, user?.id)) {
          if (!cloudRetryRequested) {
            setWorking(false);
            setRetryNeedsCloud(true);
            setExportAccountId(checkpoint.accountId);
            setFailure("This exact account signed in after an uncertain deletion response, proving the cloud account still exists. Confirm a new exact-account deletion attempt; no workspace writer will be reopened.");
            return;
          }
          checkpoint = await prepareAmbiguousAccountErasureRetry(
            checkpoint.accountId,
            checkpoint.attemptId,
          );
        }

        if (checkpoint.cloud === "pending" || checkpoint.cloud === "failed") {
          if (!cloudRetryRequested) {
            setWorking(false);
            setRetryNeedsCloud(true);
            setExportAccountId(checkpoint.accountId);
            setFailure("Account deletion is durably locked but its cloud step did not finish. Retry with the exact account still signed in; no workspace writer will be reopened.");
            return;
          }
          if (user?.id !== checkpoint.accountId) {
            setWorking(false);
            setRetryNeedsCloud(true);
            setExportAccountId(checkpoint.accountId);
            setFailure("Sign in as the exact fenced account before retrying its unfinished cloud deletion. No other account will be changed.");
            return;
          }
          if (!terminalFenced) {
            setWorking(false);
            setRetryNeedsCloud(true);
            setExportAccountId(checkpoint.accountId);
            setFailure("This tab could not adopt the exact account's durable deletion fence, so cloud cleanup was not retried.");
            return;
          }
          if (!supabase) throw new Error("Cloud connection is unavailable for the pending account deletion.");
          const advanced = await advanceCloudAccountErasure({
            checkpoint,
            eraseCloud: (onFinalDeletionStarting) => eraseConnectedAccount(
              supabase,
              checkpoint!.accountId,
              { onFinalDeletionStarting },
            ),
          });
          checkpoint = advanced.checkpoint;
          if (exactAccountProvesAmbiguousDeletionFailed(checkpoint, user?.id)) {
            setWorking(false);
            setCloudRetryRequested(false);
            setRetryNeedsCloud(true);
            setExportAccountId(checkpoint.accountId);
            setFailure("The new exact-account deletion response was also uncertain. The durable fence remains closed; confirm another retry only while this exact account is still signed in.");
            return;
          }
        }

        if (shouldFinalizeCompletedTerminalAccount(
          checkpoint,
          user?.id,
          terminalFenced ? checkpoint.accountId : null,
        )) {
          // Local/session completion markers are durable bookkeeping, not proof
          // that this provider already left the terminal account. Re-run the
          // idempotent fence cleanup and exact-session clear so this tab always
          // reaches the anonymous workspace.
          await finishActiveAccountErasure(
            checkpoint.accountId,
            checkpoint.persistenceGeneration,
            () => clearExactAccountSession(checkpoint!.accountId),
          );
        }
        const result = await resumeLocalAccountErasure({
          checkpoint,
          workspaceSwitching,
          terminalFenced,
          getAuthenticatedAccountId,
          finishActiveAccountErasure,
          eraseInactiveAccount: (target) => eraseInactiveAccountLocalData(
            target,
            window.localStorage,
          ),
          clearExactAccountSession,
        });
        if (cancelled) return;
        setWorking(false);
        setCloudRetryRequested(false);
        setAbandonRequested(false);
        setExportAccountId(null);
        if (result.sessionWarning) {
          setRetryNeedsCloud(false);
          setFailure(result.sessionWarning);
        } else {
          attemptedCheckpoint.current = "";
          setRetryEpoch((value) => value + 1);
        }
      } catch (error) {
        if (cancelled) return;
        setWorking(false);
        setRetryNeedsCloud(
          checkpoint?.cloud === "pending" || checkpoint?.cloud === "failed",
        );
        setExportAccountId(
          checkpoint?.cloud === "pending" || checkpoint?.cloud === "failed"
            ? checkpoint.accountId
            : null,
        );
        setFailure(error instanceof Error
          ? error.message
          : "The pending account data could not be erased from this device.");
      } finally {
        operationInFlight.current = false;
      }
    };

    void recover();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, [abandonRequested, adoptActiveAccountErasure, cloudRetryRequested, finishActiveAccountErasure, ready, retryEpoch, terminalErasureAccountId, user?.id, workspaceSwitching]);

  const exportFencedWorkspace = async (accountId: string) => {
    try {
      const raw = await readRawWorkspace(accountId);
      if (raw === null) throw new Error("No device workspace remains to export for this fenced account.");
      const recovered = recoverWorkspaceEnvelope(raw, accountId);
      const safeState = privacySafeWorkspaceExport(recovered.state);
      const url = URL.createObjectURL(new Blob(
        [JSON.stringify(safeState, null, 2)],
        { type: "application/json" },
      ));
      const link = document.createElement("a");
      link.href = url;
      link.download = `evolvra-fenced-workspace-${new Date().toISOString().slice(0, 10)}.json`;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      setFailure(error instanceof Error
        ? error.message
        : "The fenced device workspace could not be exported safely.");
    }
  };

  const requestExactAccountSignIn = async () => {
    const email = recoveryEmail.trim();
    if (!email) {
      setAuthMessage("Enter the email address for the exact account being recovered.");
      return;
    }
    setAuthPending(true);
    setAuthMessage(null);
    try {
      const message = await signIn(email);
      setAuthMessage(`${message} Return through that link, then retry exact account deletion.`);
    } catch (error) {
      setAuthMessage(error instanceof Error
        ? error.message
        : "A secure sign-in link could not be requested.");
    } finally {
      setAuthPending(false);
    }
  };

  if (!working && !failure) return null;
  return (
    <div
      className="loading-screen"
      role={failure ? "alertdialog" : "status"}
      aria-live="polite"
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "var(--bg)" }}
    >
      <span className="brand-mark"><ShieldCheck /></span>
      <div style={{ width: "min(560px, calc(100vw - 40px))", textAlign: "center" }}>
        <h1 style={{ fontSize: "clamp(24px, 5vw, 34px)" }}>
          {failure ? "Account cleanup needs attention" : "Finishing account cleanup…"}
        </h1>
        <p>{failure ?? "Evolvra is removing only the previously deleted account's remaining private data."}</p>
        {failure && retryNeedsCloud && exportAccountId && user?.id !== exportAccountId && (
          <form
            className="form-stack"
            style={{ marginTop: 18, textAlign: "left" }}
            onSubmit={(event) => {
              event.preventDefault();
              void requestExactAccountSignIn();
            }}
          >
            <label>
              <span>Email for the exact fenced account</span>
              <input
                type="email"
                autoComplete="email"
                required
                value={recoveryEmail}
                onChange={(event) => setRecoveryEmail(event.target.value)}
              />
            </label>
            <Button type="submit" variant="secondary" disabled={authPending}>
              {authPending ? "Sending secure link…" : "Send secure sign-in link"}
            </Button>
            {authMessage && <p role="status">{authMessage}</p>}
          </form>
        )}
        {failure && (
          <div className="button-row" style={{ justifyContent: "center", flexWrap: "wrap", marginTop: 22 }}>
            {exportAccountId && (
              <Button
                variant="secondary"
                onClick={() => void exportFencedWorkspace(exportAccountId)}
              >Export privacy-safe device copy</Button>
            )}
            <Button onClick={() => {
              attemptedCheckpoint.current = "";
              setFailure(null);
              if (retryNeedsCloud) setCloudRetryRequested(true);
              if (retryNeedsAbandon) setAbandonRequested(true);
              setRetryEpoch((value) => value + 1);
            }}>{retryNeedsAbandon
                ? "Confirm uncertain outcome and continue"
                : retryNeedsCloud
                  ? "Retry exact account deletion"
                  : "Retry device cleanup"}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
