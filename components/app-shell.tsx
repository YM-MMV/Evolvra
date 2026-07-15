"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  CheckSquare2,
  ChevronLeft,
  ChevronRight,
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
import { levelFromXp } from "@/lib/utils";

const nav: { href: string; label: string; termKey?: "goals" | "quests" | "stats"; icon: typeof LayoutDashboard }[] = [
  { href: "/", label: "Command centre", icon: LayoutDashboard },
  { href: "/goals", label: "Goals", termKey: "goals" as const, icon: Goal },
  { href: "/quests", label: "Quests", termKey: "quests" as const, icon: CheckSquare2 },
  { href: "/stats", label: "Stats", termKey: "stats" as const, icon: BarChart3 },
  { href: "/reviews", label: "Reviews", icon: Command },
  { href: "/timeline", label: "Timeline", icon: History },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { state, ready, user, syncStatus, canUndo, undo } = useApp();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const theme = state.settings.theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : state.settings.theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.intensity = state.settings.gameIntensity;
  }, [state.settings.gameIntensity, state.settings.theme]);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  if (!ready) return <div className="loading-screen"><span className="brand-mark"><Sparkles /></span><p>Preparing your command centre…</p></div>;
  if (!state.profile.onboarded) return <Onboarding />;

  const level = levelFromXp(state.overallXp, state.settings.scoring.levelBase, state.settings.scoring.levelGrowth);
  const current = nav.find((item) => item.href === pathname) ?? nav.find((item) => item.href !== "/" && pathname.startsWith(item.href));

  return (
    <div className={`app-layout ${collapsed ? "nav-collapsed" : ""}`}>
      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-top">
          <Link className="brand" href="/"><span className="brand-mark"><Sparkles size={20} /></span><span className="brand-copy"><strong>Evolvra</strong><small>Personal OS</small></span></Link>
          <button className="mobile-close icon-button" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X size={20} /></button>
        </div>
        <div className="level-card">
          <span className="level-orb">{level.level}</span>
          <div><small>Overall level</small><strong>{Math.round(level.current)} / {level.needed} XP</strong><div className="mini-track"><span style={{ width: `${level.percent}%` }} /></div></div>
        </div>
        <nav className="nav-list">
          {nav.map(({ href, label, termKey, icon: Icon }) => {
            const active = href === "/" ? pathname === href : pathname.startsWith(href);
            const displayLabel = termKey ? state.settings.terminology[termKey] : label;
            return <Link key={href} href={href} className={active ? "active" : ""} onClick={() => setMobileOpen(false)}><Icon size={19} /><span>{displayLabel}</span>{active && <i />}</Link>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <Link href="/settings" className={pathname.startsWith("/settings") ? "active" : ""}><Settings size={19} /><span>Customise</span></Link>
          <div className="sync-indicator">{user ? <Cloud size={16} /> : <CloudOff size={16} />}<span>{user ? (syncStatus === "saving" ? "Saving…" : "Cloud synced") : "Private on this device"}</span></div>
        </div>
        <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>{collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}</button>
      </aside>
      {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-title"><button className="mobile-menu icon-button" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu size={21} /></button><div><small>{current?.label ?? "Evolvra"}</small><strong>{state.profile.chapter}</strong></div></div>
          <div className="topbar-actions">
            {canUndo && <button className="undo-button" onClick={undo}><RotateCcw size={15} /><span>Undo</span></button>}
            <Link href="/goals?new=true" className="quick-add"><Plus size={17} /><span>New goal</span></Link>
            <Link href="/settings" className="avatar" aria-label="Open settings">{state.profile.displayName.slice(0, 2).toUpperCase()}</Link>
          </div>
        </header>
        <main className="page-container">{children}</main>
      </div>
    </div>
  );
}
