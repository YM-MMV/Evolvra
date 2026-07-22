"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
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
import { useApp } from "@/components/app-provider";
import { DynamicIcon, ICON_OPTIONS } from "@/components/icons";
import { Button, Field, Modal, Panel, Pill } from "@/components/ui";
import { CloudAccountErasureError, eraseConnectedAccount, getSupabase } from "@/lib/supabase";
import {
  actionableLocalErasureCheckpoint,
  advanceCloudAccountErasure,
  beginAccountErasureIntent,
  eraseInactiveAccountLocalData,
  findAccountErasureCheckpoint,
  listAccountErasureCheckpoints,
  resumeLocalAccountErasure,
  type CloudErasureStatus,
} from "@/lib/account-erasure";
import { portableWorkspaceState } from "@/lib/provider-evidence";
import { MAX_WORKSPACE_SERIALIZED_BYTES, WORKSPACE_TEXT_LIMITS } from "@/lib/state-schema";
import type { AnonymousHandoffChoice } from "@/lib/sync-reconciliation";
import { reconciledTimelineEvents } from "@/lib/timeline";
import type { Area, DashboardSectionId, LifeStat } from "@/lib/types";
import { downloadFile, escapeCsv, singularizeTerm, uid } from "@/lib/utils";

type EditItem = { kind: "area"; value?: Area } | { kind: "stat"; value?: LifeStat } | null;
const IMPORT_SUCCESS_NOTICE_KEY = "evolvra:notice:import-success";

export default function SettingsPage() {
  const {
    state, user, workspaceSwitching, terminalErasureAccountId, syncStatus, syncConflict, accountHandoff, cloudEnabled, updateProfile, updateSettings, upsertArea, reorderAreas, removeArea, upsertStat, reorderStats, removeStat,
    importState, resetWorkspace, beginActiveAccountErasure, finishActiveAccountErasure, signIn, signOut, retrySync, resolveAccountHandoff, resolveSyncConflict,
  } = useApp();
  const [active, setActive] = useState("profile");
  const [editItem, setEditItem] = useState<EditItem>(null);
  const [itemName, setItemName] = useState("");
  const [itemColor, setItemColor] = useState("#48A9FF");
  const [itemIcon, setItemIcon] = useState("Sparkles");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [dangerOpen, setDangerOpen] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [profileName, setProfileName] = useState(state.profile.displayName);
  const [profileChapter, setProfileChapter] = useState(state.profile.chapter);
  const [terminologyDraft, setTerminologyDraft] = useState(state.settings.terminology);
  const importRef = useRef<HTMLInputElement>(null);
  const term = state.settings.terminology;
  const goalTerm = singularizeTerm(term.goals);
  const areaTerm = singularizeTerm(term.areas);
  const statTerm = singularizeTerm(term.stats);
  const dashboardLabels: Record<DashboardSectionId, string> = {
    "life-map": "Year life map",
    momentum: "Recent momentum",
    goals: `Current ${term.goals.toLowerCase()}`,
    qualities: `Connected ${term.stats.toLowerCase()}`,
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
    { id: "structure", label: `${term.areas} & ${term.stats}`, icon: Sparkles },
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
    JSON.stringify(portableWorkspaceState(state), null, 2),
  );
  const exportCsv = () => {
    const rows = [["date", "type", "title", "detail", "goal", "area"], ...reconciledTimelineEvents(state).map((event) => [event.at, event.type, event.title, event.detail, state.goals.find((goal) => goal.id === event.goalId)?.title ?? "", state.areas.find((area) => area.id === event.areaId)?.name ?? ""])];
    downloadFile(`evolvra-timeline-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((row) => row.map((item) => escapeCsv(item)).join(",")).join("\n"), "text/csv");
  };
  const onImport = (event: ChangeEvent<HTMLInputElement>) => {
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
  const chooseAccountWorkspace = async (choice: AnonymousHandoffChoice) => {
    setHandoffPending(true);
    setMessage("");
    try {
      await resolveAccountHandoff(choice);
      setMessage(choice === "merge"
        ? "Device goals and activity were combined with the account. Account identity and settings were retained, and the anonymous original remains on this device."
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
        await beginActiveAccountErasure(accountId, async (expectedGeneration) => {
          const result = await beginAccountErasureIntent(
            accountId,
            expectedGeneration,
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
        const result = await advanceCloudAccountErasure({
          checkpoint,
          eraseCloud: (onFinalDeletionStarting) => eraseConnectedAccount(supabase, accountId, {
            onFinalDeletionStarting,
          }),
        });
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
          <Panel id="areas" tabIndex={-1}><SettingsHead eyebrow="Organisational folders" title={term.areas} description="Create, colour, reorder, hide, archive, or restore the divisions of your life." action={<Button onClick={() => openEdit({ kind: "area" })}><Plus size={15} /> Add {areaTerm.toLowerCase()}</Button>} /><div className="custom-list">{[...state.areas].sort((a, b) => a.order - b.order).map((area, index) => { const connected = state.goals.filter((goal) => goal.areaId === area.id).length; return <div key={area.id} className={area.archived ? "archived" : ""}><span className="custom-icon" style={{ color: area.color, background: `${area.color}18` }}><DynamicIcon name={area.icon} /></span><div><strong>{area.name}</strong><small>{connected} {connected === 1 ? goalTerm.toLowerCase() : term.goals.toLowerCase()}{area.archived ? " · archived" : area.hidden ? ` · hidden from new ${term.goals.toLowerCase()}` : ""}</small></div><div className="reorder-buttons"><button aria-label={`Move ${area.name} up`} disabled={index === 0} onClick={() => moveArea(index, -1)}><ArrowUp size={14} /></button><button aria-label={`Move ${area.name} down`} disabled={index === state.areas.length - 1} onClick={() => moveArea(index, 1)}><ArrowDown size={14} /></button></div>{!area.archived && <button className="icon-button" aria-label={area.hidden ? `Show ${area.name} in new ${goalTerm.toLowerCase()} choices` : `Hide ${area.name} from new ${goalTerm.toLowerCase()} choices`} onClick={() => upsertArea({ ...area, hidden: !area.hidden })}>{area.hidden ? <Eye size={15} /> : <EyeOff size={15} />}</button>}<button className="icon-button" aria-label={`Edit ${area.name}`} onClick={() => openEdit({ kind: "area", value: area })}><Edit3 size={15} /></button>{area.archived ? <button className="icon-button" aria-label={`Restore ${area.name}`} onClick={() => upsertArea({ ...area, archived: false })}><RotateCcw size={15} /></button> : <button className="icon-button danger" aria-label={connected ? `Archive ${area.name}` : `Delete ${area.name}`} onClick={() => removeArea(area.id)}><Trash2 size={15} /></button>}</div>; })}</div></Panel>
          <Panel id="stats" tabIndex={-1}><SettingsHead eyebrow="Personal qualities" title={term.stats} description={`Use qualities to group the ${term.goals.toLowerCase()} and actions that develop different parts of your life.`} action={<Button onClick={() => openEdit({ kind: "stat" })}><Plus size={15} /> Add {statTerm.toLowerCase()}</Button>} /><div className="custom-list">{state.stats.map((stat, index) => <div key={stat.id} className={stat.archived ? "archived" : ""}><span className="custom-icon" style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} /></span><div><strong>{stat.name}</strong><small>{stat.archived ? "Archived" : `Available for ${goalTerm.toLowerCase()} connections`}</small></div><Pill>{state.goals.filter((goal) => goal.statIds.includes(stat.id)).length} connected</Pill><div className="reorder-buttons"><button aria-label={`Move ${stat.name} up`} disabled={index === 0} onClick={() => moveStat(index, -1)}><ArrowUp size={14} /></button><button aria-label={`Move ${stat.name} down`} disabled={index === state.stats.length - 1} onClick={() => moveStat(index, 1)}><ArrowDown size={14} /></button></div><button className="icon-button" aria-label={`Edit ${stat.name}`} onClick={() => openEdit({ kind: "stat", value: stat })}><Edit3 size={15} /></button>{stat.archived ? <button className="icon-button" aria-label={`Restore ${stat.name}`} onClick={() => upsertStat({ ...stat, archived: false })}><RotateCcw size={15} /></button> : <button className="icon-button danger" aria-label={`Remove ${stat.name}`} onClick={() => removeStat(stat.id)}><Trash2 size={15} /></button>}</div>)}</div></Panel>
        </div>}

        {active === "appearance" && <div className="settings-stack">
          <Panel><SettingsHead eyebrow="Visual direction" title="Appearance" description="Choose a calm interface or increase the command-centre atmosphere." /><div className="settings-group"><h3>Theme</h3><div className="option-cards thirds">{([{ id: "dark", label: "Dark", icon: Moon }, { id: "light", label: "Light", icon: Sun }, { id: "system", label: "System", icon: Monitor }] as const).map(({ id, label, icon: Icon }) => <button key={id} className={state.settings.theme === id ? "active" : ""} aria-pressed={state.settings.theme === id} onClick={() => updateSettings({ theme: id })}><Icon /><strong>{label}</strong>{state.settings.theme === id && <Check />}</button>)}</div></div><div className="settings-group"><h3>Interface intensity</h3><div className="option-cards">{([{ id: "minimal", label: "Minimal", body: "Clean productivity language and subdued visual effects." }, { id: "balanced", label: "Balanced", body: "Structured dashboards with a light command-centre atmosphere." }, { id: "immersive", label: "Immersive", body: "Stronger glows, denser panels, and a more cinematic workspace." }] as const).map((item) => <button key={item.id} className={state.settings.interfaceIntensity === item.id ? "active" : ""} aria-pressed={state.settings.interfaceIntensity === item.id} onClick={() => updateSettings({ interfaceIntensity: item.id })}><strong>{item.label}</strong><p>{item.body}</p>{state.settings.interfaceIntensity === item.id && <Check />}</button>)}</div></div></Panel>
          <Panel><SettingsHead eyebrow="Your command centre" title="Dashboard arrangement" description="Move sections into a useful order or hide what you do not need. Hidden sections can always be restored." /><div className="custom-list">{state.settings.dashboardOrder.map((section, index) => { const hidden = state.settings.hiddenDashboardSections.includes(section); return <div key={section}><span className="custom-icon"><Monitor size={17} /></span><div><strong>{dashboardLabels[section]}</strong><small>{hidden ? "Hidden" : "Visible"}</small></div><div className="reorder-buttons"><button aria-label={`Move ${dashboardLabels[section]} up`} disabled={index === 0} onClick={() => moveDashboardSection(section, -1)}><ArrowUp size={14} /></button><button aria-label={`Move ${dashboardLabels[section]} down`} disabled={index === state.settings.dashboardOrder.length - 1} onClick={() => moveDashboardSection(section, 1)}><ArrowDown size={14} /></button></div><button className="icon-button" aria-label={hidden ? `Show ${dashboardLabels[section]}` : `Hide ${dashboardLabels[section]}`} onClick={() => updateSettings({ hiddenDashboardSections: hidden ? state.settings.hiddenDashboardSections.filter((item) => item !== section) : [...state.settings.hiddenDashboardSections, section] })}>{hidden ? <Eye size={15} /> : <EyeOff size={15} />}</button></div>; })}</div></Panel>
          <Panel><SettingsHead eyebrow="Optional and private" title="Daily reminder" description="A browser notification can gently surface ready actions while an Evolvra tab or installed app window is open. No activity data is sent away." /><div className="form-grid"><Field label="Reminder time"><input type="time" value={state.settings.reminderTime ?? "18:00"} onChange={(event) => updateSettings({ reminderTime: event.target.value })} /></Field><div className="button-row end"><Button variant={state.settings.notifications ? "secondary" : "primary"} onClick={() => void toggleReminders()}><Bell size={16} /> {state.settings.notifications ? "Turn reminders off" : "Turn reminders on"}</Button></div></div></Panel>
        </div>}

        {active === "language" && <Panel><SettingsHead eyebrow="Your words" title="Terminology" description="Rename the main concepts globally so the system feels natural to you." /><div className="form-grid">{Object.entries(terminologyDraft).map(([key, value]) => { const termKey = key as keyof typeof term; return <Field key={key} label={`Default: ${key[0].toUpperCase()}${key.slice(1)}`}><input maxLength={WORKSPACE_TEXT_LIMITS.terminology} value={value} onChange={(e) => setTerminologyDraft((current) => ({ ...current, [key]: e.target.value }))} onBlur={() => { const nextValue = value.trim(); if (!nextValue) { setTerminologyDraft((current) => ({ ...current, [termKey]: term[termKey] })); return; } const nextTerminology = { ...terminologyDraft, [termKey]: nextValue }; if (Object.entries(nextTerminology).every(([entryKey, entryValue]) => term[entryKey as keyof typeof term] === entryValue)) return; setTerminologyDraft(nextTerminology); updateSettings({ terminology: nextTerminology }); }} /></Field>; })}</div><div className="setting-note"><Sparkles size={17} /><p>Examples: Goals → Missions, Quests → Actions, Areas → Realms, Milestones → Chapters, Stats → Attributes.</p></div></Panel>}

        {active === "sync" && <Panel>
          <SettingsHead eyebrow="Private by design" title="Sync & privacy" description="The app works locally first. Supabase adds private cross-device sync when you choose." />
          <div className={`cloud-status ${user && syncStatus === "synced" && !accountHandoff ? "connected" : ""}`}>
            <span>{user ? <Cloud /> : <HardDrive />}</span>
            <div>
              <strong>{user ? `Connected as ${user.email}` : "Stored privately on this device"}</strong>
              <p>{user
                ? accountHandoff
                  ? "Sync is paused until you keep, merge, or replace these separate workspaces. Nothing is copied automatically."
                  : syncStatus === "synced"
                    ? "This device and the private cloud snapshot are up to date."
                    : syncStatus === "offline"
                      ? "You are offline. Changes remain saved on this device and will sync after reconnection."
                      : syncStatus === "unsaved"
                        ? "Changes are saved on this device and waiting for private sync."
                        : syncStatus === "saving"
                          ? "Saving the latest local changes…"
                          : syncStatus === "connecting"
                            ? "Checking for newer private changes…"
                            : syncStatus === "conflict"
                              ? "Both this device and the cloud have unsaved changes. Choose which copy to keep."
                              : "Sync could not finish. Your device copy is still safe and can be retried."
                : "No account is required for local use. Export backups whenever you like."}</p>
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
              <p>This anonymous device workspace has {accountHandoff.goalCount} {accountHandoff.goalCount === 1 ? goalTerm.toLowerCase() : term.goals.toLowerCase()} and {accountHandoff.activityCount} saved activity {accountHandoff.activityCount === 1 ? "record" : "records"}. It was last changed {new Date(accountHandoff.anonymousUpdatedAt).toLocaleString("en-GB")}.</p>
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

        {active === "data" && <Panel><SettingsHead eyebrow="Ownership & recovery" title="Your data" description="Export workspace records, restore a snapshot, or erase the workspace completely." /><div className="data-actions"><button onClick={exportJson}><span><Download /></span><div><strong>Workspace JSON backup</strong><p>Every {term.goals.toLowerCase()}, {term.stats.toLowerCase()}, review, setting, and event. File contents and private account locations are not embedded.</p></div></button><button onClick={exportCsv}><span><Download /></span><div><strong>Timeline CSV</strong><p>The same reconciled permanent record shown on the Timeline page, ready for a spreadsheet.</p></div></button><button onClick={() => importRef.current?.click()}><span><Upload /></span><div><strong>Restore workspace records</strong><p>Import a previous Evolvra JSON file. Evidence files must be attached again after restore.</p></div></button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={onImport} /></div><div className="danger-zone"><div><strong>Erase this workspace</strong><p>Delete local data, cloud snapshots, and the connected account. Export a backup first.</p></div><Button variant="danger" onClick={() => setDangerOpen(true)}><Trash2 size={15} /> Erase everything</Button></div></Panel>}

        {message && <div className="toast-message" role="status" aria-live="polite"><Check size={16} />{message}<button aria-label="Dismiss message" onClick={() => setMessage("")}>×</button></div>}
      </div>
    </div>

    <Modal open={Boolean(editItem)} onClose={() => setEditItem(null)} eyebrow={editItem?.kind === "area" ? "Life structure" : "Personal quality"} title={`${editItem?.value ? "Edit" : "Add"} ${editItem?.kind === "area" ? areaTerm.toLowerCase() : editItem?.kind === "stat" ? statTerm.toLowerCase() : "item"}`}><div className="form-stack"><Field label="Name"><input data-modal-autofocus="true" maxLength={WORKSPACE_TEXT_LIMITS.areaOrQualityName} value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder={editItem?.kind === "area" ? "Creative work" : "Leadership"} /></Field><div className="form-grid"><Field label="Colour"><div className="color-input"><input aria-label="Choose colour" type="color" value={itemColor} onChange={(e) => setItemColor(e.target.value)} /><input aria-label="Colour value" maxLength={WORKSPACE_TEXT_LIMITS.color} value={itemColor} onChange={(e) => setItemColor(e.target.value)} /></div></Field><Field label="Icon"><select value={itemIcon} onChange={(e) => setItemIcon(e.target.value)}>{ICON_OPTIONS.map((icon) => <option key={icon}>{icon}</option>)}</select></Field></div><div className="icon-preview" style={{ color: itemColor, background: `${itemColor}18` }}><DynamicIcon name={itemIcon} size={24} /><strong>{itemName || "Preview"}</strong></div><div className="button-row end"><Button variant="ghost" onClick={() => setEditItem(null)}>Cancel</Button><Button disabled={!itemName.trim()} onClick={saveItem}><Save size={15} /> Save</Button></div></div></Modal>
    <Modal open={dangerOpen} onClose={() => { if (!erasing) setDangerOpen(false); }} eyebrow="Permanent action" title="Erase your Evolvra workspace?"><div className="danger-confirm"><span><Trash2 /></span><p>This removes all information in this workspace and, if connected, its cloud snapshot and account. Other account workspaces and the anonymous original stay separate on this device. Evolvra keeps an account-scoped cleanup checkpoint if cloud deletion finishes before device cleanup, so retry never depends on the deleted session.</p><div className="button-row end"><Button variant="ghost" disabled={erasing} onClick={() => setDangerOpen(false)}>Keep my data</Button><Button variant="danger" disabled={erasing} onClick={eraseEverything}>{erasing ? "Erasing…" : "Erase everything"}</Button></div></div></Modal>
  </div>;
}

function SettingsHead({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="settings-head"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}
