"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Archive,
  Check,
  Cloud,
  Database,
  Download,
  Edit3,
  Eye,
  EyeOff,
  HardDrive,
  LogOut,
  Monitor,
  Moon,
  Bell,
  Palette,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import {
  useAppActions,
  useProviderStatus,
  useWorkspaceData,
} from "@/components/app-provider";
import type { PortableWorkspaceArchiveImportPreview } from "@/components/app-context";
import { DynamicIcon, ICON_OPTIONS } from "@/components/icons";
import { Button, Field, Modal, Panel, Pill } from "@/components/ui";
import {
  CloudAccountErasureError,
  eraseConnectedAccount,
  getSupabase,
  isStaleAccountErasureBackupError,
  readAccountErasureBackupBoundary,
} from "@/lib/supabase";
import {
  actionableLocalErasureCheckpoint,
  advanceCloudAccountErasure,
  beginAccountErasureIntent,
  cancelUnstartedAccountErasureIntent,
  eraseInactiveAccountLocalData,
  findAccountErasureCheckpoint,
  listAccountErasureCheckpoints,
  resumeLocalAccountErasure,
  type CloudErasureStatus,
} from "@/lib/account-erasure";
import { portableWorkspaceState } from "@/lib/provider-evidence";
import { MAX_PORTABLE_WORKSPACE_ARCHIVE_BYTES } from "@/lib/portable-workspace-archive";
import { settingsSyncStatusDescription } from "@/lib/provider-selectors";
import { MAX_WORKSPACE_SERIALIZED_BYTES, WORKSPACE_TEXT_LIMITS } from "@/lib/state-schema";
import type { AnonymousHandoffChoice } from "@/lib/sync-reconciliation";
import { terminologyForms, type TerminologyKey } from "@/lib/terminology";
import { reconciledTimelineEvents } from "@/lib/timeline";
import type { Area, DashboardSectionId, LifeStat } from "@/lib/types";
import { downloadFile, escapeCsv, uid } from "@/lib/utils";
import {
  forecastWorkspaceCapacity,
  formatWorkspaceBytes,
  workspaceCapacityForecastText,
} from "@/lib/workspace-capacity";

type EditItem = { kind: "area"; value?: Area } | { kind: "stat"; value?: LifeStat } | null;
const IMPORT_SUCCESS_NOTICE_KEY = "evolvra:notice:import-success";

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export default function SettingsPage() {
  const { state, workspaceScopeKey } = useWorkspaceData();
  const {
    user, workspaceSwitching, terminalErasureAccountId, syncStatus, syncConflict, accountHandoff, cloudEnabled,
  } = useProviderStatus();
  const {
    updateProfile, updateSettings, upsertArea, reorderAreas, removeArea, upsertStat, reorderStats, removeStat,
    importState, exportPortableWorkspaceArchive, inspectPortableWorkspaceArchive,
    discardPortableWorkspaceArchiveImport, applyPortableWorkspaceArchive,
    resetWorkspace, beginActiveAccountErasure, cancelActiveAccountErasure, finishActiveAccountErasure, signIn, signOut, retrySync, resolveAccountHandoff, resolveSyncConflict,
  } = useAppActions();
  const [active, setActive] = useState("profile");
  const [editItem, setEditItem] = useState<EditItem>(null);
  const [itemName, setItemName] = useState("");
  const [itemColor, setItemColor] = useState("#48A9FF");
  const [itemIcon, setItemIcon] = useState("Sparkles");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [dangerOpen, setDangerOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archivePreparedForReset, setArchivePreparedForReset] = useState<string | null>(null);
  const [archivePreparedForErasure, setArchivePreparedForErasure] = useState<string | null>(null);
  const [erasing, setErasing] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [portableArchivePending, setPortableArchivePending] = useState(false);
  const [portableImportPreview, setPortableImportPreview] =
    useState<PortableWorkspaceArchiveImportPreview | null>(null);
  const [profileName, setProfileName] = useState(state.profile.displayName);
  const [profileChapter, setProfileChapter] = useState(state.profile.chapter);
  const [terminologyDraft, setTerminologyDraft] = useState(state.settings.terminology);
  const terminologyDraftRef = useRef(state.settings.terminology);
  const recordsImportRef = useRef<HTMLInputElement>(null);
  const portableImportRef = useRef<HTMLInputElement>(null);
  const term = state.settings.terminology;
  const terms = terminologyForms(term);
  const capacity = useMemo(
    () => forecastWorkspaceCapacity(state),
    [state],
  );
  const dashboardLabels: Record<DashboardSectionId, string> = {
    hero: "Welcome and quick actions",
    overview: "KPI overview",
    "due-now": "Due now rail",
    "life-map": "Year life map",
    momentum: "Recent momentum",
    goals: `Current ${terms.goals.pluralLower}`,
    qualities: `Connected ${terms.stats.pluralLower}`,
    review: "Review prompt",
  };

  useEffect(() => {
    let noticeTimer: number | undefined;
    try {
      const notice = sessionStorage.getItem(IMPORT_SUCCESS_NOTICE_KEY);
      if (notice) {
        sessionStorage.removeItem(IMPORT_SUCCESS_NOTICE_KEY);
        noticeTimer = window.setTimeout(() => setMessage(notice), 0);
      }
    } catch {
      // The imported workspace still opens when transient browser storage is blocked.
    }
    return () => window.clearTimeout(noticeTimer);
  }, []);

  useEffect(() => {
    // A downloaded archive authorizes only the exact account and workspace
    // revision that produced it. Close the confirmation as soon as either
    // identity or visible workspace state changes.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setArchivePreparedForErasure(null);
      setDangerOpen(false);
      setArchiveOpen(false);
    });
    return () => { cancelled = true; };
  }, [state.updatedAt, user?.id, workspaceScopeKey]);

  const editTerminology = (key: TerminologyKey, value: string) => {
    const next = { ...terminologyDraftRef.current, [key]: value };
    terminologyDraftRef.current = next;
    setTerminologyDraft(next);
  };

  const saveTerminology = (key: TerminologyKey) => {
    const nextValue = terminologyDraftRef.current[key].trim();
    if (!nextValue) {
      const restored = { ...terminologyDraftRef.current, [key]: term[key] };
      terminologyDraftRef.current = restored;
      setTerminologyDraft(restored);
      return;
    }
    const next = { ...terminologyDraftRef.current, [key]: nextValue };
    terminologyDraftRef.current = next;
    setTerminologyDraft(next);
    if (Object.entries(next).every(([entryKey, entryValue]) => term[entryKey as TerminologyKey] === entryValue)) return;
    updateSettings({ terminology: next });
  };

  useEffect(() => {
    const followStructureLink = () => {
      const targetId = window.location.hash.slice(1);
      if (targetId !== "areas" && targetId !== "stats") return;
      setActive("structure");
      window.requestAnimationFrame(() => {
        const target = document.getElementById(targetId);
        target?.scrollIntoView({ block: "start" });
        target?.focus({ preventScroll: true });
      });
    };
    followStructureLink();
    window.addEventListener("hashchange", followStructureLink);
    return () => window.removeEventListener("hashchange", followStructureLink);
  }, []);

  const sections = [
    { id: "profile", label: "Profile", icon: User },
    { id: "structure", label: `${terms.areas.plural} & ${terms.stats.plural}`, icon: Sparkles },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "language", label: "Terminology", icon: Edit3 },
    { id: "sync", label: "Sync & privacy", icon: Cloud },
    { id: "data", label: "Data & recovery", icon: Database },
  ];

  const openEdit = (item: EditItem) => {
    setEditItem(item);
    setItemName(item?.value?.name ?? "");
    setItemColor(item?.value?.color ?? "#48A9FF");
    setItemIcon(item?.value?.icon ?? "Sparkles");
  };
  const saveItem = () => {
    if (!editItem || !itemName.trim()) return;
    if (editItem.kind === "area") upsertArea({ id: editItem.value?.id ?? uid("area"), name: itemName.trim(), color: itemColor, icon: itemIcon, order: editItem.value?.order ?? state.areas.length, hidden: editItem.value?.hidden, archived: editItem.value?.archived });
    else upsertStat({ id: editItem.value?.id ?? uid("stat"), name: itemName.trim(), color: itemColor, icon: itemIcon, archived: editItem.value?.archived });
    setEditItem(null);
  };
  const moveArea = (index: number, direction: -1 | 1) => {
    const sorted = [...state.areas].sort((a, b) => a.order - b.order);
    const other = sorted[index + direction];
    const current = sorted[index];
    if (!other || !current) return;
    const next = [...sorted];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    reorderAreas(next.map((area) => area.id));
  };
  const moveStat = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= state.stats.length) return;
    const next = [...state.stats];
    [next[index], next[target]] = [next[target], next[index]];
    reorderStats(next.map((stat) => stat.id));
  };
  const moveDashboardSection = (section: DashboardSectionId, direction: -1 | 1) => {
    const index = state.settings.dashboardOrder.indexOf(section);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= state.settings.dashboardOrder.length) return;
    const next = [...state.settings.dashboardOrder];
    [next[index], next[target]] = [next[target], next[index]];
    updateSettings({ dashboardOrder: next });
  };
  const toggleReminders = async () => {
    if (state.settings.notifications) {
      updateSettings({ notifications: false });
      return;
    }
    if (typeof Notification === "undefined") {
      setMessage("This browser does not support local notifications.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setMessage("Notification permission was not granted. Reminders remain off.");
      return;
    }
    updateSettings({ notifications: true });
    setMessage("A private daily reminder will run while an Evolvra tab or installed app window is open.");
  };
  const exportJson = () => downloadFile(
    `evolvra-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(portableWorkspaceState(state)),
  );
  const exportCsv = () => {
    const rows = [["date", "type", "title", "detail", "goal", "area"], ...reconciledTimelineEvents(state).map((event) => [event.at, event.type, event.title, event.detail, state.goals.find((goal) => goal.id === event.goalId)?.title ?? "", state.areas.find((area) => area.id === event.areaId)?.name ?? ""])];
    downloadFile(`evolvra-timeline-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((row) => row.map((item) => escapeCsv(item)).join(",")).join("\n"), "text/csv");
  };
  const requestFullBackupDownload = async (prepareForAccountErasure = false) => {
    const archive = await exportPortableWorkspaceArchive({
      prepareForAccountErasure,
    });
    downloadBlob(archive.fileName, archive.blob);
    return archive;
  };
  const exportFullBackup = async () => {
    setPortableArchivePending(true);
    setMessage("");
    try {
      const archive = await requestFullBackupDownload();
      setMessage(
        `Complete portable backup downloaded with ${archive.evidenceFiles.toLocaleString("en-GB")} evidence ${archive.evidenceFiles === 1 ? "file" : "files"} (${formatWorkspaceBytes(archive.evidenceBytes)}).`,
      );
    } catch (error) {
      setMessage(error instanceof Error
        ? error.message
        : "A complete portable backup could not be created. No full-backup download was reported.");
    } finally {
      setPortableArchivePending(false);
    }
  };
  const archiveAndReset = async () => {
    setArchiving(true);
    setMessage("");
    try {
      if (!user && archivePreparedForReset) {
        await resetWorkspace(archivePreparedForReset);
        setArchivePreparedForReset(null);
        setArchiveOpen(false);
        setMessage("The confirmed portable backup remains available and the anonymous workspace was reset.");
        return;
      }
      const archive = await requestFullBackupDownload(Boolean(user));
      if (user) {
        setArchivePreparedForErasure(archive.resetReceiptToken);
        setArchiveOpen(false);
        setDangerOpen(true);
        setMessage("Your complete portable backup download was requested. Confirm that it is available, then review the separate account-erasure confirmation.");
        return;
      }
      setArchivePreparedForReset(archive.resetReceiptToken);
      setMessage("Your complete portable backup download was requested. Confirm that the .evolvra file is available before resetting this workspace.");
    } catch (error) {
      setArchivePreparedForReset(null);
      setMessage(error instanceof Error
        ? `The workspace was not reset: ${error.message}`
        : "The workspace was not reset. Export a backup and try again.");
    } finally {
      setArchiving(false);
    }
  };
  const onRecordsImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > MAX_WORKSPACE_SERIALIZED_BYTES) { setMessage("That backup is too large to import safely. Choose a file no larger than 5 MB."); event.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        try {
          sessionStorage.setItem(IMPORT_SUCCESS_NOTICE_KEY, "Workspace restored successfully.");
        } catch {
          // The provider import remains authoritative; this key only survives its intentional remount.
        }
        await importState(JSON.parse(String(reader.result)));
        setMessage("Workspace restored successfully.");
      } catch (error) {
        try {
          sessionStorage.removeItem(IMPORT_SUCCESS_NOTICE_KEY);
        } catch {
          // No transient notice was retained.
        }
        setMessage(error instanceof Error ? error.message : "That file is not a valid Evolvra backup.");
      }
    };
    reader.readAsText(file); event.target.value = "";
  };
  const onPortableImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_PORTABLE_WORKSPACE_ARCHIVE_BYTES) {
      setMessage("That portable backup exceeds the supported 1 GiB limit.");
      return;
    }
    setPortableArchivePending(true);
    setMessage("");
    try {
      const preview = await inspectPortableWorkspaceArchive(file);
      setPortableImportPreview(preview);
    } catch (error) {
      setPortableImportPreview(null);
      setMessage(error instanceof Error
        ? error.message
        : "That file is not a valid complete Evolvra portable backup.");
    } finally {
      setPortableArchivePending(false);
    }
  };
  const closePortableImport = () => {
    if (portableArchivePending) return;
    if (portableImportPreview) {
      discardPortableWorkspaceArchiveImport(portableImportPreview.token);
    }
    setPortableImportPreview(null);
  };
  const restorePortableArchive = async (choice: "merge" | "replace") => {
    if (!portableImportPreview) return;
    setPortableArchivePending(true);
    setMessage("");
    const action = choice === "merge"
      ? "merged into this workspace"
      : "replaced this workspace";
    const successNotice = `Complete portable backup ${action} with ${portableImportPreview.importedEvidenceFiles.toLocaleString("en-GB")} evidence ${portableImportPreview.importedEvidenceFiles === 1 ? "file" : "files"}.`;
    try {
      try {
        sessionStorage.setItem(IMPORT_SUCCESS_NOTICE_KEY, successNotice);
      } catch {
        // The durable import remains authoritative; this only survives its intentional remount.
      }
      const result = await applyPortableWorkspaceArchive(
        portableImportPreview.token,
        choice,
      );
      setPortableImportPreview(null);
      setMessage(
        `${successNotice}${result.cleanupWarning ? ` ${result.cleanupWarning}` : ""}`,
      );
    } catch (error) {
      try {
        sessionStorage.removeItem(IMPORT_SUCCESS_NOTICE_KEY);
      } catch {
        // No transient success notice was retained.
      }
      setPortableImportPreview(null);
      setMessage(error instanceof Error
        ? error.message
        : "The portable backup was not restored.");
    } finally {
      setPortableArchivePending(false);
    }
  };
  const chooseAccountWorkspace = async (choice: AnonymousHandoffChoice) => {
    setHandoffPending(true);
    setMessage("");
    try {
      await resolveAccountHandoff(choice);
      setMessage(choice === "merge"
        ? `Device ${terms.goals.pluralLower} and activity were combined with the account. Account identity and settings were retained, and the anonymous original remains on this device.`
        : choice === "device"
          ? "The account workspace was replaced with this device copy. The anonymous original remains on this device."
          : "The account workspace is opening. The anonymous device workspace remains stored separately.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The workspace choice could not be completed.");
    } finally {
      setHandoffPending(false);
    }
  };
  const eraseEverything = async () => {
    setErasing(true);
    setMessage("");
    let erasureTarget: string | null = user?.id ?? null;
    let cloudStatus: CloudErasureStatus | "not-required" = user ? "pending" : "not-required";
    let cloudDeletionStarted = false;
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
          return " The account data was erased, but this tab could not clear its expired sign-in session; close the tab before another person uses this browser.";
        }
        if (await getAuthenticatedAccountId() !== targetAccountId) return null;
        const { error } = await supabase.auth.signOut({ scope: "local" });
        return error
          ? " The account data was erased, but this tab could not clear its expired sign-in session; close the tab before another person uses this browser."
          : null;
      };
      const inventory = await listAccountErasureCheckpoints();
      if (inventory.corrupt.length) {
        throw new Error("A damaged account-cleanup checkpoint must be reviewed before starting another deletion.");
      }
      const pendingLocalCleanup = actionableLocalErasureCheckpoint(
        inventory.checkpoints,
      );
      if (pendingLocalCleanup) {
        erasureTarget = pendingLocalCleanup.accountId;
        cloudStatus = pendingLocalCleanup.cloud;
        const result = await resumeLocalAccountErasure({
          checkpoint: pendingLocalCleanup,
          workspaceSwitching,
          terminalFenced: terminalErasureAccountId === pendingLocalCleanup.accountId,
          getAuthenticatedAccountId,
          finishActiveAccountErasure,
          eraseInactiveAccount: (checkpoint) => eraseInactiveAccountLocalData(
            checkpoint,
            window.localStorage,
          ),
          clearExactAccountSession,
        });
        setDangerOpen(false);
        setMessage(`The previously deleted account's remaining device data was erased without changing any other account or anonymous workspace.${result.sessionWarning ?? ""}`);
        return;
      }

      if (!user) {
        await resetWorkspace();
        setDangerOpen(false);
        setMessage("The anonymous local workspace, undo recovery, evidence cache, and reminder metadata were erased.");
        return;
      }

      const accountId = user.id;
      if (!supabase) throw new Error("Cloud connection is unavailable. Your local workspace was kept.");
      let checkpoint = await findAccountErasureCheckpoint(accountId);
      let terminalFenceOwned = terminalErasureAccountId === accountId;
      if (!checkpoint) {
        let begun: Awaited<ReturnType<typeof beginAccountErasureIntent>> | null = null;
        const backupReceiptToken = archivePreparedForErasure;
        if (!backupReceiptToken) {
          throw new Error("Download a fresh complete portable backup before erasing this connected account.");
        }
        // Mirror the provider's one-shot receipt consumption in the UI. A
        // failed attempt must return through the full-backup flow instead of
        // presenting a stale confirmation button again.
        setArchivePreparedForErasure(null);
        await beginActiveAccountErasure(accountId, backupReceiptToken, async (
          expectedGeneration,
          expectedLocalRevision,
          expectedEvidenceRevision,
          backup,
        ) => {
          const result = await beginAccountErasureIntent(
            accountId,
            expectedGeneration,
            { expectedLocalRevision, expectedEvidenceRevision, backup },
          );
          begun = result;
          return result.scope;
        });
        if (!begun) throw new Error("The durable account-erasure checkpoint was not created.");
        checkpoint = (begun as Awaited<ReturnType<typeof beginAccountErasureIntent>>).checkpoint;
        terminalFenceOwned = true;
      } else if (!terminalFenceOwned && checkpoint.local === "pending") {
        throw new Error("Another tab fenced this account for deletion. Reload this tab to resume its exact cleanup safely.");
      }
      let cloudWarning: string | null = null;
      if (
        checkpoint.cloud === "pending"
        || checkpoint.cloud === "failed"
      ) {
        const cloudBackupBoundary = checkpoint.backup;
        if (!cloudBackupBoundary) {
          throw new Error("This pending deletion has no verified cloud backup boundary. Contact support before retrying it.");
        }
        let result: Awaited<ReturnType<typeof advanceCloudAccountErasure>>;
        try {
          result = await advanceCloudAccountErasure({
            checkpoint,
            eraseCloud: (onFinalDeletionStarting) => eraseConnectedAccount(supabase, accountId, {
              backupBoundary: cloudBackupBoundary,
              onFinalDeletionStarting,
            }),
          });
        } catch (error) {
          if (isStaleAccountErasureBackupError(error) && terminalFenceOwned) {
            // The PT409 is authoritative, but require one fresh authenticated
            // active-lifecycle read before reopening local writers.
            await readAccountErasureBackupBoundary(supabase, accountId);
            const failed = await findAccountErasureCheckpoint(accountId);
            if (!failed || failed.attemptId !== checkpoint.attemptId) {
              throw new Error("The stale cloud backup was rejected, but its exact local checkpoint could not be verified for cancellation.");
            }
            await cancelActiveAccountErasure(
              accountId,
              failed.persistenceGeneration,
              () => cancelUnstartedAccountErasureIntent(failed),
            );
            terminalFenceOwned = false;
            setArchivePreparedForErasure(null);
            setDangerOpen(false);
          }
          throw error;
        }
        cloudStatus = result.cloud;
        cloudWarning = result.warning;
        cloudDeletionStarted = true;
        checkpoint = result.checkpoint;
      } else if (checkpoint.cloud === "finalizing") {
        throw new Error("The final account deletion request still owns a live recovery lease. Wait for device cleanup to resume.");
      } else {
        cloudStatus = checkpoint.cloud;
      }

      const localResult = await resumeLocalAccountErasure({
        checkpoint,
        workspaceSwitching,
        terminalFenced: terminalFenceOwned,
        getAuthenticatedAccountId,
        finishActiveAccountErasure,
        eraseInactiveAccount: (target) => eraseInactiveAccountLocalData(
          target,
          window.localStorage,
        ),
        clearExactAccountSession,
      });
      setDangerOpen(false);
      setMessage(cloudStatus === "ambiguous"
        ? `The exact account's device data was erased, but the final cloud response was lost. The account may already be deleted; if it still accepts sign-in, retry erasure to confirm the cloud step.${localResult.sessionWarning ?? ""}${cloudWarning ? ` Detail: ${cloudWarning}` : ""}`
        : `The local workspace, undo recovery, evidence cache, cloud data, and connected account were erased.${localResult.sessionWarning ?? ""}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The erase operation did not finish.";
      if (error instanceof CloudAccountErasureError) {
        cloudDeletionStarted = error.stage !== "begin";
      }
      setMessage(
        erasureTarget && (cloudStatus === "complete" || cloudStatus === "ambiguous")
          ? `Cloud deletion ${cloudStatus === "complete" ? "finished" : "may have finished"}, but the exact account's device cleanup did not: ${detail} Its durable cleanup checkpoint was kept, so retry does not depend on the deleted session.`
          : cloudDeletionStarted
            ? `Account deletion is locked against new evidence uploads, but cloud cleanup did not finish: ${detail} The local copy remains available and the same account can retry.`
            : `Cloud/account erasure failed before local cleanup: ${detail} The local workspace remains available so you can export or retry.`,
      );
    } finally {
      setErasing(false);
    }
  };

  return <div>
    <section className="page-header"><div><p className="eyebrow">Make the system yours</p><h1>Customise Evolvra</h1><p className="page-lead">Your language, structure, appearance, and data stay under your control.</p></div></section>
    <div className="settings-layout">
      <nav className="settings-nav panel" aria-label="Settings sections">{sections.map(({ id, label, icon: Icon }) => <button key={id} className={active === id ? "active" : ""} aria-current={active === id ? "page" : undefined} onClick={() => setActive(id)}><Icon size={17} /><span>{label}</span></button>)}</nav>
      <div className="settings-content">
        {active === "profile" && <Panel><SettingsHead eyebrow="Identity" title="Profile & chapter" description="Shape the context shown across your command centre." /><div className="form-stack"><Field label="Display name"><input maxLength={WORKSPACE_TEXT_LIMITS.profileName} value={profileName} onChange={(e) => setProfileName(e.target.value)} onBlur={() => { if (profileName !== state.profile.displayName) updateProfile({ displayName: profileName }); }} /></Field><Field label="Current chapter" hint="A short description of your main season or objective"><input maxLength={WORKSPACE_TEXT_LIMITS.profileChapter} value={profileChapter} onChange={(e) => setProfileChapter(e.target.value)} onBlur={() => { if (profileChapter !== state.profile.chapter) updateProfile({ chapter: profileChapter }); }} /></Field><Field label="Birth date" hint="Used only for the life calendar and age display"><input type="date" value={state.settings.birthDate ?? ""} onChange={(e) => updateSettings({ birthDate: e.target.value || undefined })} /></Field></div></Panel>}

        {active === "structure" && <div className="settings-stack">
          <Panel id="areas" tabIndex={-1}><SettingsHead eyebrow="Organisational folders" title={terms.areas.plural} description="Create, colour, reorder, hide, archive, or restore the divisions of your life." action={<Button onClick={() => openEdit({ kind: "area" })}><Plus size={15} /> Add {terms.areas.singularLower}</Button>} /><div className="custom-list">{[...state.areas].sort((a, b) => a.order - b.order).map((area, index) => { const connected = state.goals.filter((goal) => goal.areaId === area.id).length; return <div key={area.id} className={area.archived ? "archived" : ""}><span className="custom-icon" style={{ color: area.color, background: `${area.color}18` }}><DynamicIcon name={area.icon} /></span><div><strong>{area.name}</strong><small>{connected} {connected === 1 ? terms.goals.singularLower : terms.goals.pluralLower}{area.archived ? " · archived" : area.hidden ? ` · hidden from new ${terms.goals.pluralLower}` : ""}</small></div><div className="reorder-buttons"><button aria-label={`Move ${area.name} up`} disabled={index === 0} onClick={() => moveArea(index, -1)}><ArrowUp size={14} /></button><button aria-label={`Move ${area.name} down`} disabled={index === state.areas.length - 1} onClick={() => moveArea(index, 1)}><ArrowDown size={14} /></button></div>{!area.archived && <button className="icon-button" aria-label={area.hidden ? `Show ${area.name} in new ${terms.goals.singularLower} choices` : `Hide ${area.name} from new ${terms.goals.singularLower} choices`} onClick={() => upsertArea({ ...area, hidden: !area.hidden })}>{area.hidden ? <Eye size={15} /> : <EyeOff size={15} />}</button>}<button className="icon-button" aria-label={`Edit ${area.name}`} onClick={() => openEdit({ kind: "area", value: area })}><Edit3 size={15} /></button>{area.archived ? <button className="icon-button" aria-label={`Restore ${area.name}`} onClick={() => upsertArea({ ...area, archived: false })}><RotateCcw size={15} /></button> : <button className="icon-button danger" aria-label={connected ? `Archive ${area.name}` : `Delete ${area.name}`} onClick={() => removeArea(area.id)}><Trash2 size={15} /></button>}</div>; })}</div></Panel>
          <Panel id="stats" tabIndex={-1}><SettingsHead eyebrow={`Personal ${terms.stats.pluralLower}`} title={terms.stats.plural} description={`Use ${terms.stats.pluralLower} to group the ${terms.goals.pluralLower} and ${terms.quests.pluralLower} that develop different parts of your life.`} action={<Button onClick={() => openEdit({ kind: "stat" })}><Plus size={15} /> Add {terms.stats.singularLower}</Button>} /><div className="custom-list">{state.stats.map((stat, index) => <div key={stat.id} className={stat.archived ? "archived" : ""}><span className="custom-icon" style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} /></span><div><strong>{stat.name}</strong><small>{stat.archived ? "Archived" : `Available for ${terms.goals.singularLower} connections`}</small></div><Pill>{state.goals.filter((goal) => goal.statIds.includes(stat.id)).length} connected</Pill><div className="reorder-buttons"><button aria-label={`Move ${stat.name} up`} disabled={index === 0} onClick={() => moveStat(index, -1)}><ArrowUp size={14} /></button><button aria-label={`Move ${stat.name} down`} disabled={index === state.stats.length - 1} onClick={() => moveStat(index, 1)}><ArrowDown size={14} /></button></div><button className="icon-button" aria-label={`Edit ${stat.name}`} onClick={() => openEdit({ kind: "stat", value: stat })}><Edit3 size={15} /></button>{stat.archived ? <button className="icon-button" aria-label={`Restore ${stat.name}`} onClick={() => upsertStat({ ...stat, archived: false })}><RotateCcw size={15} /></button> : <button className="icon-button danger" aria-label={`Remove ${stat.name}`} onClick={() => removeStat(stat.id)}><Trash2 size={15} /></button>}</div>)}</div></Panel>
        </div>}

        {active === "appearance" && <div className="settings-stack">
          <Panel><SettingsHead eyebrow="Visual direction" title="Appearance" description="Choose a calm interface or increase the command-centre atmosphere." /><div className="settings-group"><h3>Theme</h3><div className="option-cards thirds">{([{ id: "dark", label: "Dark", icon: Moon }, { id: "light", label: "Light", icon: Sun }, { id: "system", label: "System", icon: Monitor }] as const).map(({ id, label, icon: Icon }) => <button key={id} className={state.settings.theme === id ? "active" : ""} aria-pressed={state.settings.theme === id} onClick={() => updateSettings({ theme: id })}><Icon /><strong>{label}</strong>{state.settings.theme === id && <Check />}</button>)}</div></div><div className="settings-group"><h3>Interface intensity</h3><div className="option-cards">{([{ id: "minimal", label: "Minimal", body: "Clean productivity language and subdued visual effects." }, { id: "balanced", label: "Balanced", body: "Structured dashboards with a light command-centre atmosphere." }, { id: "immersive", label: "Immersive", body: "Stronger glows, denser panels, and a more cinematic workspace." }] as const).map((item) => <button key={item.id} className={state.settings.interfaceIntensity === item.id ? "active" : ""} aria-pressed={state.settings.interfaceIntensity === item.id} onClick={() => updateSettings({ interfaceIntensity: item.id })}><strong>{item.label}</strong><p>{item.body}</p>{state.settings.interfaceIntensity === item.id && <Check />}</button>)}</div></div></Panel>
          <Panel><SettingsHead eyebrow="Your command centre" title="Dashboard arrangement" description="Move sections into a useful order or hide what you do not need. Hidden sections can always be restored." /><div className="custom-list">{state.settings.dashboardOrder.map((section, index) => { const hidden = state.settings.hiddenDashboardSections.includes(section); return <div key={section}><span className="custom-icon"><Monitor size={17} /></span><div><strong>{dashboardLabels[section]}</strong><small>{hidden ? "Hidden" : "Visible"}</small></div><div className="reorder-buttons"><button aria-label={`Move ${dashboardLabels[section]} up`} disabled={index === 0} onClick={() => moveDashboardSection(section, -1)}><ArrowUp size={14} /></button><button aria-label={`Move ${dashboardLabels[section]} down`} disabled={index === state.settings.dashboardOrder.length - 1} onClick={() => moveDashboardSection(section, 1)}><ArrowDown size={14} /></button></div><button className="icon-button" aria-label={hidden ? `Show ${dashboardLabels[section]}` : `Hide ${dashboardLabels[section]}`} onClick={() => updateSettings({ hiddenDashboardSections: hidden ? state.settings.hiddenDashboardSections.filter((item) => item !== section) : [...state.settings.hiddenDashboardSections, section] })}>{hidden ? <Eye size={15} /> : <EyeOff size={15} />}</button></div>; })}</div></Panel>
          <Panel><SettingsHead eyebrow="Optional and private" title="Daily reminder" description={`A browser notification can gently surface ready ${terms.quests.pluralLower} while an Evolvra tab or installed app window is open. No activity data is sent away.`} /><div className="form-grid"><Field label="Reminder time"><input type="time" value={state.settings.reminderTime ?? "18:00"} onChange={(event) => updateSettings({ reminderTime: event.target.value })} /></Field><div className="button-row end"><Button variant={state.settings.notifications ? "secondary" : "primary"} onClick={() => void toggleReminders()}><Bell size={16} /> {state.settings.notifications ? "Turn reminders off" : "Turn reminders on"}</Button></div></div></Panel>
        </div>}

        {active === "language" && <Panel><SettingsHead eyebrow="Your words" title="Terminology" description="Rename the main concepts globally so the system feels natural to you." /><div className="form-grid">{Object.entries(terminologyDraft).map(([key, value]) => { const termKey = key as TerminologyKey; return <Field key={key} label={`Default: ${key[0].toUpperCase()}${key.slice(1)}`}><input maxLength={WORKSPACE_TEXT_LIMITS.terminology} value={value} onChange={(e) => editTerminology(termKey, e.target.value)} onBlur={() => saveTerminology(termKey)} /></Field>; })}</div><div className="setting-note"><Sparkles size={17} /><p>Examples: Goals → Missions, Quests → Actions, Areas → Realms, Milestones → Chapters, Stats → Attributes.</p></div></Panel>}

        {active === "sync" && <Panel>
          <SettingsHead eyebrow="Private by design" title="Sync & privacy" description="The app works locally first. Supabase adds private cross-device sync when you choose." />
          <div className={`cloud-status ${user && syncStatus === "synced" && !accountHandoff ? "connected" : ""}`}>
            <span>{user ? <Cloud /> : <HardDrive />}</span>
            <div>
              <strong>{user ? `Connected as ${user.email}` : "Stored privately on this device"}</strong>
              <p>{settingsSyncStatusDescription({
                authenticated: Boolean(user),
                handoffPending: Boolean(accountHandoff),
                syncStatus,
              })}</p>
            </div>
            {user && <Button variant="secondary" disabled={authPending || handoffPending} onClick={async () => {
              setAuthPending(true);
              try { await signOut(); }
              catch (error) { setMessage(error instanceof Error ? error.message : "Could not sign out."); }
              finally { setAuthPending(false); }
            }}><LogOut size={15} /> {authPending ? "Signing out…" : "Sign out"}</Button>}
          </div>

          {accountHandoff && <div className="sync-conflict" role="alert">
            <div>
              <strong>Choose which workspace to open</strong>
              <p>This anonymous device workspace has {accountHandoff.goalCount} {accountHandoff.goalCount === 1 ? terms.goals.singularLower : terms.goals.pluralLower} and {accountHandoff.activityCount} saved activity {accountHandoff.activityCount === 1 ? "record" : "records"}. It was last changed {new Date(accountHandoff.anonymousUpdatedAt).toLocaleString("en-GB")}.</p>
              <p>Merge combines its data with the account while retaining the account profile, terminology, appearance, and settings. Nothing has been copied yet, and the anonymous original remains stored separately whichever option you choose.</p>
            </div>
            <div className="button-row">
              <Button variant="secondary" disabled={handoffPending} onClick={() => void chooseAccountWorkspace("account")}>Keep account/cloud workspace</Button>
              <Button disabled={handoffPending} onClick={() => void chooseAccountWorkspace("merge")}>{handoffPending ? "Applying choice…" : "Merge device data into account"}</Button>
              <Button variant="secondary" disabled={handoffPending} onClick={() => void chooseAccountWorkspace("device")}>Replace account with device copy</Button>
            </div>
          </div>}

          {!accountHandoff && syncConflict && <div className="sync-conflict" role="alert">
            <div><strong>Choose the source of truth</strong><p>Device changes: {new Date(syncConflict.localUpdatedAt).toLocaleString("en-GB")} · Cloud changes: {new Date(syncConflict.remoteUpdatedAt).toLocaleString("en-GB")}</p></div>
            <div className="button-row"><Button variant="secondary" onClick={() => resolveSyncConflict("cloud")}>Use cloud copy</Button><Button onClick={() => resolveSyncConflict("device")}>Keep this device</Button></div>
          </div>}
          {user && syncStatus === "error" && <div className="button-row end"><Button variant="secondary" onClick={retrySync}><RotateCcw size={15} /> Retry sync</Button></div>}
          {!user && <div className="sync-form"><Field label="Email address" hint={cloudEnabled ? "We will send a secure magic link — no password needed." : "Add Supabase keys to .env.local before connecting."}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></Field><Button disabled={!email || !cloudEnabled || authPending} onClick={async () => { setAuthPending(true); try { setMessage(await signIn(email)); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not connect."); } finally { setAuthPending(false); } }}><Cloud size={16} /> {authPending ? "Sending link…" : "Connect private sync"}</Button></div>}
          <div className="privacy-list"><div><ShieldCheck /><span><strong>Row-level security</strong><small>Every cloud record is restricted to the signed-in account.</small></span></div><div><Save /><span><strong>Indexed device storage</strong><small>Your account-scoped workspace and recent undo history stay available offline.</small></span></div><div><RotateCcw /><span><strong>Conflict-safe sync</strong><small>Concurrent device changes are never silently overwritten.</small></span></div></div>
        </Panel>}

        {active === "data" && <Panel>
          <SettingsHead eyebrow="Ownership & recovery" title="Your data" description="Monitor workspace capacity, export records, restore a snapshot, or erase the workspace completely." />
          <section
            className={`capacity-card capacity-${capacity.severity}`}
            role={capacity.severity === "healthy" ? "status" : "alert"}
            aria-label="Workspace capacity"
          >
            <div className="capacity-summary">
              <span>{capacity.severity === "healthy" ? <Database /> : <AlertTriangle />}</span>
              <div>
                <strong>Workspace capacity</strong>
                <p>{formatWorkspaceBytes(capacity.serializedBytes)} of {formatWorkspaceBytes(capacity.limitBytes)} used · {Math.round(capacity.utilisationRatio * 100)}%</p>
              </div>
              <Pill>{capacity.severity === "critical" ? "Action needed" : capacity.severity === "watch" ? "Plan ahead" : "Healthy"}</Pill>
            </div>
            <progress
              max={capacity.limitBytes}
              value={capacity.serializedBytes}
              aria-label={`${Math.round(capacity.utilisationRatio * 100)}% of workspace capacity used`}
            />
            <div className="capacity-guidance">
              <p><strong>{capacity.severity === "critical" ? "Archive now to preserve room for new records." : capacity.severity === "watch" ? "Plan a backup and fresh workspace soon." : "There is comfortable room for new records."}</strong> {workspaceCapacityForecastText(capacity)}</p>
              {capacity.estimatedAdditionalActivityRecords !== null && <small>Based on the recent average record size, about {capacity.estimatedAdditionalActivityRecords.toLocaleString("en-GB")} similar activity records would fit before the hard limit. This is an estimate, not a guarantee.</small>}
            </div>
            <Button variant="secondary" onClick={() => { setArchivePreparedForReset(null); setArchiveOpen(true); }}><Archive size={15} /> Archive and start fresh</Button>
          </section>
          <div className="data-actions">
            <button disabled={portableArchivePending || workspaceSwitching} onClick={() => void exportFullBackup()}><span><HardDrive /></span><div><strong>Complete portable backup</strong><p>One checksummed .evolvra file with workspace records and every referenced evidence file. Missing referenced bytes stop the download; unreferenced orphan records are not included.</p></div></button>
            <button
              disabled={portableArchivePending || workspaceSwitching || Boolean(syncConflict) || Boolean(accountHandoff)}
              title={syncConflict || accountHandoff ? "Resolve the active source-of-truth choice before restoring a portable backup." : undefined}
              onClick={() => portableImportRef.current?.click()}
            ><span><Upload /></span><div><strong>Restore complete portable backup</strong><p>{syncConflict || accountHandoff ? "Resolve the active source-of-truth choice first; export remains available." : "Inspect a .evolvra file first, then explicitly merge it or replace this workspace."}</p></div></button>
            <input ref={portableImportRef} data-testid="portable-archive-input" disabled={Boolean(syncConflict) || Boolean(accountHandoff)} hidden type="file" accept=".evolvra,application/vnd.evolvra.workspace-archive" onChange={(event) => void onPortableImport(event)} />
            <button onClick={exportJson}><span><Download /></span><div><strong>Records-only JSON backup</strong><p>Every {terms.goals.singularLower}, {terms.stats.singularLower}, review, setting, and event. Evidence file contents and private account locations are deliberately excluded.</p></div></button>
            <button onClick={exportCsv}><span><Download /></span><div><strong>Timeline CSV</strong><p>The same reconciled permanent record shown on the Timeline page, ready for a spreadsheet.</p></div></button>
            <button onClick={() => recordsImportRef.current?.click()}><span><Upload /></span><div><strong>Restore records-only JSON</strong><p>Import a previous Evolvra JSON file. Evidence files must be attached again after restore.</p></div></button>
            <input ref={recordsImportRef} hidden type="file" accept="application/json,.json" onChange={onRecordsImport} />
          </div>
          <div className="danger-zone"><div><strong>Erase this workspace</strong><p>Delete local data, cloud snapshots, and the connected account. Export a backup first.</p></div><Button variant="danger" onClick={() => { setArchivePreparedForErasure(null); if (user) setArchiveOpen(true); else setDangerOpen(true); }}><Trash2 size={15} /> Erase everything</Button></div>
        </Panel>}

        {message && <div className="toast-message" role="status" aria-live="polite"><Check size={16} />{message}<button aria-label="Dismiss message" onClick={() => setMessage("")}>×</button></div>}
      </div>
    </div>

    <Modal open={Boolean(editItem)} onClose={() => setEditItem(null)} eyebrow={editItem?.kind === "area" ? "Life structure" : `Personal ${terms.stats.singularLower}`} title={`${editItem?.value ? "Edit" : "Add"} ${editItem?.kind === "area" ? terms.areas.singularLower : editItem?.kind === "stat" ? terms.stats.singularLower : "item"}`}><div className="form-stack"><Field label="Name"><input data-modal-autofocus="true" maxLength={WORKSPACE_TEXT_LIMITS.areaOrQualityName} value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder={editItem?.kind === "area" ? "Creative work" : "Leadership"} /></Field><div className="form-grid"><Field label="Colour"><div className="color-input"><input aria-label="Choose colour" type="color" value={itemColor} onChange={(e) => setItemColor(e.target.value)} /><input aria-label="Colour value" maxLength={WORKSPACE_TEXT_LIMITS.color} value={itemColor} onChange={(e) => setItemColor(e.target.value)} /></div></Field><Field label="Icon"><select value={itemIcon} onChange={(e) => setItemIcon(e.target.value)}>{ICON_OPTIONS.map((icon) => <option key={icon}>{icon}</option>)}</select></Field></div><div className="icon-preview" style={{ color: itemColor, background: `${itemColor}18` }}><DynamicIcon name={itemIcon} size={24} /><strong>{itemName || "Preview"}</strong></div><div className="button-row end"><Button variant="ghost" onClick={() => setEditItem(null)}>Cancel</Button><Button disabled={!itemName.trim()} onClick={saveItem}><Save size={15} /> Save</Button></div></div></Modal>
    <Modal open={Boolean(portableImportPreview)} onClose={closePortableImport} eyebrow="Verified portable backup" title="Merge or replace this workspace?">
      {portableImportPreview && <div className="archive-confirm portable-import-choice">
        <span><ShieldCheck /></span>
        <p>The archive passed its format, schema, metadata, and SHA-256 integrity checks. It was created {new Date(portableImportPreview.archiveCreatedAt).toLocaleString("en-GB")} from workspace records last updated {new Date(portableImportPreview.archiveWorkspaceUpdatedAt).toLocaleString("en-GB")}.</p>
        <p><strong>{portableImportPreview.importedEvidenceFiles.toLocaleString("en-GB")} evidence {portableImportPreview.importedEvidenceFiles === 1 ? "file" : "files"}</strong> · {formatWorkspaceBytes(portableImportPreview.importedEvidenceBytes)}</p>
        <div className="portable-import-options">
          <div><strong>Merge and preserve</strong><p>Keep this workspace and its device evidence. Imported records and files receive collision-free identifiers. Archive restore is a recovery operation and cannot be undone from recent history.</p><Button disabled={portableArchivePending || Boolean(syncConflict) || Boolean(accountHandoff)} onClick={() => void restorePortableArchive("merge")}>{portableArchivePending ? "Restoring…" : "Merge into this workspace"}</Button></div>
          <div className="destructive-choice"><strong>Replace everything here</strong><p>Discard current workspace records and replace its device evidence in one durable transaction. This cannot be undone from recent history.</p><Button variant="danger" disabled={portableArchivePending || Boolean(syncConflict) || Boolean(accountHandoff)} onClick={() => void restorePortableArchive("replace")}>{portableArchivePending ? "Restoring…" : "Replace this workspace"}</Button></div>
        </div>
        <div className="button-row end"><Button variant="ghost" disabled={portableArchivePending} onClick={closePortableImport}>Cancel restore</Button></div>
      </div>}
    </Modal>
    <Modal open={archiveOpen} onClose={() => { if (!archiving) { setArchiveOpen(false); setArchivePreparedForReset(null); } }} eyebrow="Capacity recovery" title="Archive this workspace and start fresh?"><div className="archive-confirm"><span><Archive /></span>{archivePreparedForReset && !user ? <><p><strong>Confirm the downloaded backup before resetting.</strong></p><p>Open your downloads and make sure the .evolvra file is available. Reset removes this anonymous workspace, its undo recovery, device evidence, and reminder metadata. If this workspace changed in any tab after the download, reset is refused and a fresh backup is required.</p></> : <><p>Evolvra will first create a complete, checksummed .evolvra backup containing workspace records and evidence file bytes. If any referenced file is unavailable on this device and in its verified private cloud location, the reset is refused.</p>{user ? <p>Your connected cloud copy would restore itself after a device-only reset. To avoid pretending that data is gone, the next step opens the separate account-erasure confirmation; nothing is erased from this dialog.</p> : <p>After the backup download is requested, Evolvra will ask you to confirm that the file is available before resetting anything.</p>}</>}<div className="button-row end"><Button variant="ghost" disabled={archiving} onClick={() => { setArchiveOpen(false); setArchivePreparedForReset(null); }}>Keep this workspace</Button><Button variant={user || archivePreparedForReset ? "danger" : "primary"} disabled={archiving} onClick={() => void archiveAndReset()}>{archiving ? archivePreparedForReset ? "Resetting…" : "Preparing full backup…" : user ? "Download full backup, then review erasure" : archivePreparedForReset ? "I have the backup — reset workspace" : "Download full backup"}</Button></div></div></Modal>
    <Modal open={dangerOpen} onClose={() => { if (!erasing) { setDangerOpen(false); setArchivePreparedForErasure(null); } }} eyebrow="Permanent action" title="Erase your Evolvra workspace?"><div className="danger-confirm"><span><Trash2 /></span>{archivePreparedForErasure && <p>Your complete portable backup download was requested. Confirm that the .evolvra file is available before continuing. If this account or workspace changed after that download, erasure is refused.</p>}<p>This removes all information in this workspace and, if connected, its cloud snapshot and account. Other account workspaces and the anonymous original stay separate on this device. Evolvra keeps an account-scoped cleanup checkpoint if cloud deletion finishes before device cleanup, so retry never depends on the deleted session.</p><div className="button-row end"><Button variant="ghost" disabled={erasing} onClick={() => { setDangerOpen(false); setArchivePreparedForErasure(null); }}>Keep my data</Button><Button variant="danger" disabled={erasing || Boolean(user && !archivePreparedForErasure)} onClick={eraseEverything}>{erasing ? "Erasing…" : "Erase everything"}</Button></div></div></Modal>
  </div>;
}

function SettingsHead({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="settings-head"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}
