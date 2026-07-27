"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  CheckSquare2,
  Cloud,
  CloudOff,
  Command,
  Goal,
  History,
  LayoutDashboard,
  Menu,
  Plus,
  RotateCcw,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Onboarding } from "@/components/onboarding";
import { PwaRegistration } from "@/components/pwa-registration";
import { ReminderScheduler } from "@/components/reminder-scheduler";
import { Button } from "@/components/ui";
import { privacySafeWorkspaceExport } from "@/lib/persistence";
import { MAX_WORKSPACE_SERIALIZED_BYTES } from "@/lib/state-schema";
import type { AnonymousHandoffChoice } from "@/lib/sync-reconciliation";
import { singularizeTerm } from "@/lib/utils";

const MOBILE_NAV_QUERY = "(max-width: 900px)";
const DRAWER_FOCUSABLE_SELECTOR = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

function visibleDrawerControls(drawer: HTMLElement) {
  return [...drawer.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hidden
      && element.getAttribute("aria-hidden") !== "true"
      && element.getClientRects().length > 0);
}

function drawerIsTopmostDialog(drawer: HTMLElement) {
  const dialogs = [...document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']")];
  return dialogs.at(-1) === drawer;
}

const nav: { href: string; label: string; termKey?: "goals" | "quests" | "stats"; icon: typeof LayoutDashboard }[] = [
  { href: "/", label: "Command centre", icon: LayoutDashboard },
  { href: "/goals", label: "Goals", termKey: "goals" as const, icon: Goal },
  { href: "/quests", label: "Quests", termKey: "quests" as const, icon: CheckSquare2 },
  { href: "/stats", label: "Stats", termKey: "stats" as const, icon: BarChart3 },
  { href: "/reviews", label: "Reviews", icon: Command },
  { href: "/timeline", label: "Timeline", icon: History },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    state,
    ready,
    workspaceSwitching,
    workspaceScopeKey,
    user,
    syncStatus,
    accountHandoff,
    localWorkspaceConflict,
    quarantinedRecovery,
    canUndo,
    undo,
    persistenceError,
    importState,
    discardQuarantinedWorkspace,
    resolveAccountHandoff,
    signOut,
  } = useApp();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [workspaceChoicePending, setWorkspaceChoicePending] = useState(false);
  const [workspaceChoiceError, setWorkspaceChoiceError] = useState("");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const workspaceChoiceDialogRef = useRef<HTMLDivElement>(null);
  const localConflictDialogRef = useRef<HTMLDivElement>(null);
  const recoveryInputRef = useRef<HTMLInputElement>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");

  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: light)");
    const applyTheme = () => {
      document.documentElement.dataset.theme = state.settings.theme === "system"
        ? (preference.matches ? "light" : "dark")
        : state.settings.theme;
    };
    applyTheme();
    document.documentElement.dataset.intensity = state.settings.interfaceIntensity;
    if (state.settings.theme !== "system") return;
    preference.addEventListener("change", applyTheme);
    return () => preference.removeEventListener("change", applyTheme);
  }, [state.settings.interfaceIntensity, state.settings.theme]);

  useEffect(() => {
    if (!mobileOpen) return;
    const mobileViewport = window.matchMedia(MOBILE_NAV_QUERY);
    if (!mobileViewport.matches) return;
    const drawer = sidebarRef.current;
    if (!drawer) return;
    const menuButton = menuButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      if (!drawerIsTopmostDialog(drawer)) return;
      const closeButton = drawer.querySelector<HTMLElement>(".mobile-close");
      (closeButton ?? visibleDrawerControls(drawer)[0] ?? drawer).focus({ preventScroll: true });
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!drawerIsTopmostDialog(drawer)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = visibleDrawerControls(drawer);
      if (!focusable.length) {
        event.preventDefault();
        drawer.focus({ preventScroll: true });
        return;
      }
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (!drawer.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastItem : firstItem).focus();
      } else if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem?.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem?.focus();
      }
    };
    const closeAtDesktopWidth = (event: MediaQueryListEvent) => {
      if (!event.matches) setMobileOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    mobileViewport.addEventListener("change", closeAtDesktopWidth);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      mobileViewport.removeEventListener("change", closeAtDesktopWidth);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => {
        if (menuButton?.isConnected) menuButton.focus({ preventScroll: true });
      });
    };
  }, [mobileOpen]);

  useEffect(() => {
    if (!workspaceSwitching || !accountHandoff) return;
    const dialog = workspaceChoiceDialogRef.current;
    if (!dialog) return;
    const focusableControls = () => visibleDrawerControls(dialog);
    const focusTimer = window.setTimeout(() => {
      (focusableControls()[0] ?? dialog).focus({ preventScroll: true });
    }, 0);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = focusableControls();
      if (!controls.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", trapFocus);
    };
  }, [accountHandoff, workspaceSwitching]);

  useEffect(() => {
    if (!localWorkspaceConflict) return;
    const dialog = localConflictDialogRef.current;
    if (!dialog) return;
    const focusableControls = () => visibleDrawerControls(dialog);
    const focusTimer = window.setTimeout(() => {
      (focusableControls()[0] ?? dialog).focus({ preventScroll: true });
    }, 0);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = focusableControls();
      if (!controls.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", trapFocus);
    };
  }, [localWorkspaceConflict]);

  const exportCurrentMemory = () => {
    const safeState = privacySafeWorkspaceExport(state);
    const blob = new Blob([JSON.stringify(safeState, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `evolvra-unsaved-memory-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const chooseWorkspace = async (choice: AnonymousHandoffChoice) => {
    setWorkspaceChoicePending(true);
    setWorkspaceChoiceError("");
    try {
      await resolveAccountHandoff(choice);
    } catch (error) {
      setWorkspaceChoiceError(error instanceof Error
        ? error.message
        : "The workspace choice could not be completed.");
    } finally {
      setWorkspaceChoicePending(false);
    }
  };

  const cancelWorkspaceSwitch = async () => {
    setWorkspaceChoicePending(true);
    setWorkspaceChoiceError("");
    try {
      await signOut();
    } catch (error) {
      setWorkspaceChoiceError(error instanceof Error
        ? error.message
        : "Could not return to the device workspace.");
    } finally {
      setWorkspaceChoicePending(false);
    }
  };

  if (!ready) return <div className="loading-screen"><span className="brand-mark"><Sparkles /></span><p>Preparing your command centre…</p></div>;
  if (localWorkspaceConflict) {
    return (
      <div
        ref={localConflictDialogRef}
        className="loading-screen"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="local-workspace-conflict-title"
        aria-describedby="local-workspace-conflict-description"
      >
        <span className="brand-mark"><CloudOff /></span>
        <div style={{ width: "min(560px, calc(100vw - 40px))", textAlign: "center" }}>
          <h1 id="local-workspace-conflict-title" style={{ fontSize: "clamp(24px, 5vw, 34px)" }}>This workspace changed in another tab</h1>
          <p id="local-workspace-conflict-description">{localWorkspaceConflict.message} Download this tab&apos;s in-memory records before reloading if you need to preserve its unsaved changes.</p>
          <p>File contents stored only on this device are not embedded in the download, and private account identifiers are removed from file references.</p>
          <div className="button-row" style={{ justifyContent: "center", flexWrap: "wrap", marginTop: 22 }}>
            <Button variant="secondary" onClick={exportCurrentMemory}>Download unsaved memory copy</Button>
            <Button onClick={() => window.location.reload()}>Reload latest device copy</Button>
          </div>
        </div>
      </div>
    );
  }
  if (workspaceSwitching) {
    return (
      <div
        ref={accountHandoff ? workspaceChoiceDialogRef : undefined}
        className="loading-screen"
        role={accountHandoff ? "dialog" : "status"}
        tabIndex={accountHandoff ? -1 : undefined}
        aria-modal={accountHandoff ? true : undefined}
        aria-labelledby={accountHandoff ? "workspace-choice-title" : undefined}
        aria-live={accountHandoff ? undefined : "polite"}
      >
        <span className="brand-mark"><Sparkles /></span>
        {accountHandoff ? (
          <div style={{ width: "min(680px, calc(100vw - 40px))", textAlign: "center" }}>
            <h1 id="workspace-choice-title" style={{ fontSize: "clamp(24px, 5vw, 34px)" }}>Choose which private workspace to open</h1>
            <p>This signed-in account and this device have separate workspaces. Nothing is copied automatically.</p>
            <p>Merging combines their goals and activity while keeping the account profile, terminology, appearance, and other settings. The anonymous original stays separately on this device.</p>
            {workspaceChoiceError && <div className="system-alert" role="alert">{workspaceChoiceError}</div>}
            <div className="button-row" style={{ justifyContent: "center", flexWrap: "wrap", marginTop: 22 }}>
              <Button variant="secondary" disabled={workspaceChoicePending} onClick={() => void chooseWorkspace("account")}>Keep account/cloud workspace</Button>
              <Button disabled={workspaceChoicePending} onClick={() => void chooseWorkspace("merge")}>{workspaceChoicePending ? "Applying choice…" : "Merge device data into account"}</Button>
              <Button variant="secondary" disabled={workspaceChoicePending} onClick={() => void chooseWorkspace("device")}>Replace account with device copy</Button>
              <Button variant="ghost" disabled={workspaceChoicePending} onClick={() => void cancelWorkspaceSwitch()}>Cancel and sign out</Button>
            </div>
          </div>
        ) : <p>Opening your private workspace…</p>}
      </div>
    );
  }
  if (quarantinedRecovery) {
    const downloadRaw = () => {
      if (!quarantinedRecovery.rawJson) return;
      const url = URL.createObjectURL(new Blob([quarantinedRecovery.rawJson], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `evolvra-quarantined-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    };
    return <div className="loading-screen" role="alertdialog" aria-modal="true" aria-labelledby="recovery-title" aria-describedby="recovery-description">
      <span className="brand-mark"><CloudOff /></span>
      <div style={{ width: "min(620px, calc(100vw - 40px))", textAlign: "center" }}>
        <h1 id="recovery-title" style={{ fontSize: "clamp(24px, 5vw, 34px)" }}>This device copy needs recovery</h1>
        <p id="recovery-description">{quarantinedRecovery.message}</p>
        <p>Evolvra will not overwrite it. Download the damaged envelope for support, restore a validated backup, or explicitly erase only this account&apos;s device copy.</p>
        {recoveryError && <div className="system-alert" role="alert">{recoveryError}</div>}
        <div className="button-row" style={{ justifyContent: "center", flexWrap: "wrap", marginTop: 22 }}>
          <Button variant="secondary" disabled={!quarantinedRecovery.rawJson || recoveryPending} onClick={downloadRaw}>Download damaged copy</Button>
          <Button variant="secondary" disabled={recoveryPending} onClick={() => recoveryInputRef.current?.click()}>Restore backup</Button>
          <Button disabled={recoveryPending} onClick={async () => {
            if (!window.confirm("Erase this quarantined device copy and its device-only evidence? Cloud data is not erased.")) return;
            setRecoveryPending(true); setRecoveryError("");
            try { await discardQuarantinedWorkspace(); } catch (error) { setRecoveryError(error instanceof Error ? error.message : "The quarantined device copy could not be erased."); } finally { setRecoveryPending(false); }
          }}>{recoveryPending ? "Working…" : "Erase device copy"}</Button>
        </div>
        <input ref={recoveryInputRef} hidden type="file" accept="application/json,.json" onChange={async (event) => {
          const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
          if (file.size > MAX_WORKSPACE_SERIALIZED_BYTES) {
            setRecoveryError("That backup is too large to import safely. Choose a file no larger than 5 MB.");
            return;
          }
          setRecoveryPending(true); setRecoveryError("");
          try { await importState(JSON.parse(await file.text()) as unknown); } catch (error) { setRecoveryError(error instanceof Error ? error.message : "The selected backup could not be restored."); } finally { setRecoveryPending(false); }
        }} />
      </div>
    </div>;
  }
  if (!state.profile.onboarded) return <Onboarding key={workspaceScopeKey} systemAlert={persistenceError} />;

  const activeGoalCount = state.goals.filter((goal) => goal.status === "active").length;
  const completedActionCount = state.questCompletions.length;
  const goalTerm = singularizeTerm(state.settings.terminology.goals);
  const current = nav.find((item) => item.href === pathname) ?? nav.find((item) => item.href !== "/" && pathname.startsWith(item.href));
  const currentLabel = pathname.startsWith("/settings")
    ? "Customise"
    : current?.termKey
      ? state.settings.terminology[current.termKey]
      : current?.label ?? "Evolvra";
  const syncLabel = !user
    ? "Private on this device"
    : syncStatus === "persisting"
      ? "Saving to this device…"
      : syncStatus === "offline"
        ? "Offline — saved on this device"
        : syncStatus === "unsaved"
          ? "Changes waiting to sync"
          : syncStatus === "saving"
            ? "Saving changes…"
            : syncStatus === "connecting"
              ? "Connecting to private sync…"
              : syncStatus === "conflict"
                ? "Sync choice required"
                : syncStatus === "error"
                  ? "Sync needs attention"
                  : "Private sync up to date";

  return (
    <div className="app-layout">
      <aside ref={sidebarRef} id="primary-navigation" tabIndex={mobileOpen ? -1 : undefined} role={mobileOpen ? "dialog" : undefined} aria-modal={mobileOpen ? true : undefined} aria-label="Primary navigation" className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-top">
          <Link className="brand" href="/" onClick={() => setMobileOpen(false)}><span className="brand-mark"><Sparkles size={20} /></span><span className="brand-copy"><strong>Evolvra</strong><small>Personal OS</small></span></Link>
          <button className="mobile-close icon-button" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X size={20} /></button>
        </div>
        <nav className="nav-list">
          {nav.map(({ href, label, termKey, icon: Icon }) => {
            const active = href === "/" ? pathname === href : pathname.startsWith(href);
            const displayLabel = termKey ? state.settings.terminology[termKey] : label;
            return <Link key={href} href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={() => setMobileOpen(false)}><Icon size={17} /><span>{displayLabel}</span>{active && <i />}</Link>;
          })}
        </nav>
        <div className="workspace-summary" aria-label={`${activeGoalCount} active ${state.settings.terminology.goals.toLowerCase()} and ${completedActionCount} completed actions recorded`}>
          <span className="workspace-orb"><Goal size={18} /></span>
          <div><small>Current focus</small><strong>{activeGoalCount} active {activeGoalCount === 1 ? goalTerm.toLowerCase() : state.settings.terminology.goals.toLowerCase()}</strong><span>{completedActionCount} completed {completedActionCount === 1 ? "action" : "actions"} recorded</span></div>
        </div>
        <div className="sidebar-bottom">
          <Link href="/settings" aria-label="Customise settings" className={pathname.startsWith("/settings") ? "active" : ""} aria-current={pathname.startsWith("/settings") ? "page" : undefined} onClick={() => setMobileOpen(false)}><Settings size={17} /><span>Customise</span></Link>
          <div className={`sync-indicator sync-${syncStatus}`} role="status" aria-live="polite">{user && syncStatus !== "error" && syncStatus !== "offline" && syncStatus !== "persisting" ? <Cloud size={16} /> : <CloudOff size={16} />}<span>{syncLabel}</span></div>
        </div>
      </aside>
      {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
      <div className="app-main" inert={mobileOpen ? true : undefined} aria-hidden={mobileOpen ? true : undefined}>
        <header className="topbar">
          <div className="topbar-title"><button ref={menuButtonRef} className="mobile-menu icon-button" onClick={(event) => { event.currentTarget.blur(); setMobileOpen(true); }} aria-label="Open menu" aria-haspopup="dialog" aria-expanded={mobileOpen} aria-controls="primary-navigation"><Menu size={21} /></button><div><small>Workspace / {currentLabel}</small><strong>{state.profile.chapter}</strong></div></div>
          <div className="topbar-actions">
            {canUndo && <button className="undo-button" onClick={undo} aria-label="Undo most recent change"><RotateCcw size={15} /><span>Undo</span></button>}
            <Link href="/goals?new=true" className="quick-add" aria-label={`Create a new ${goalTerm.toLowerCase()}`}><Plus size={17} /><span>New {goalTerm.toLowerCase()}</span></Link>
            <Link href="/settings" className="avatar" aria-label="Open settings">{state.profile.displayName.slice(0, 2).toUpperCase()}</Link>
          </div>
        </header>
        <PwaRegistration />
        <ReminderScheduler />
        {persistenceError && <div className="system-alert" role="alert">{persistenceError}</div>}
        <main key={workspaceScopeKey} id="main-content" tabIndex={-1} className="page-container">{children}</main>
        <footer className="system-footer">
          <span><i className={user && syncStatus === "synced" ? "online" : "local"} />{user ? syncLabel.toUpperCase() : "LOCAL-FIRST MODE"}</span>
          <span>{completedActionCount.toLocaleString("en-GB")} COMPLETED ACTIONS</span>
          <span>EVOLVRA / BETA</span>
        </footer>
      </div>
    </div>
  );
}
