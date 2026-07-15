"use client";

import { ChangeEvent, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Check,
  Cloud,
  Database,
  Download,
  Edit3,
  HardDrive,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import { useApp } from "@/components/app-provider";
import { DynamicIcon, ICON_OPTIONS } from "@/components/icons";
import { Button, Field, Modal, Panel, Pill } from "@/components/ui";
import { getSupabase } from "@/lib/supabase";
import type { Area, LifeStat, UserSettings } from "@/lib/types";
import { downloadFile, escapeCsv, uid } from "@/lib/utils";

type EditItem = { kind: "area"; value?: Area } | { kind: "stat"; value?: LifeStat } | null;

export default function SettingsPage() {
  const {
    state, user, syncStatus, cloudEnabled, updateProfile, updateSettings, upsertArea, removeArea, upsertStat, removeStat,
    importState, resetWorkspace, signIn, signOut,
  } = useApp();
  const [active, setActive] = useState("profile");
  const [editItem, setEditItem] = useState<EditItem>(null);
  const [itemName, setItemName] = useState("");
  const [itemColor, setItemColor] = useState("#48A9FF");
  const [itemIcon, setItemIcon] = useState("Sparkles");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [dangerOpen, setDangerOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const term = state.settings.terminology;

  const sections = [
    { id: "profile", label: "Profile", icon: User },
    { id: "structure", label: "Areas & stats", icon: Sparkles },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "language", label: "Terminology", icon: Edit3 },
    { id: "scoring", label: "Scoring & levels", icon: SlidersHorizontal },
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
    else upsertStat({ id: editItem.value?.id ?? uid("stat"), name: itemName.trim(), color: itemColor, icon: itemIcon, xp: editItem.value?.xp ?? 0, archived: editItem.value?.archived });
    setEditItem(null);
  };
  const moveArea = (index: number, direction: -1 | 1) => {
    const sorted = [...state.areas].sort((a, b) => a.order - b.order);
    const other = sorted[index + direction];
    const current = sorted[index];
    if (!other || !current) return;
    upsertArea({ ...current, order: other.order });
    upsertArea({ ...other, order: current.order });
  };
  const setScoring = (section: keyof UserSettings["scoring"], key: string | number, value?: number) => {
    const scoring = structuredClone(state.settings.scoring);
    if (typeof scoring[section] === "object") (scoring[section] as Record<string, number>)[String(key)] = value ?? 0;
    else if (section === "questCap") scoring.questCap = Number(key);
    else if (section === "levelBase") scoring.levelBase = Number(key);
    else if (section === "levelGrowth") scoring.levelGrowth = Number(key);
    updateSettings({ scoring });
  };
  const requestNotifications = async () => {
    if (!("Notification" in window)) { setMessage("This browser does not support notifications."); return; }
    const permission = await Notification.requestPermission();
    updateSettings({ notifications: permission === "granted" });
    setMessage(permission === "granted" ? "Notifications enabled for future reminders." : "Notification permission was not granted.");
  };
  const exportJson = () => downloadFile(`evolvra-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 2));
  const exportCsv = () => {
    const rows = [["date", "type", "title", "detail", "xp", "goal", "area"], ...state.timeline.map((event) => [event.at, event.type, event.title, event.detail, event.xp ?? "", state.goals.find((goal) => goal.id === event.goalId)?.title ?? "", state.areas.find((area) => area.id === event.areaId)?.name ?? ""])];
    downloadFile(`evolvra-timeline-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((row) => row.map((item) => escapeCsv(item)).join(",")).join("\n"), "text/csv");
  };
  const onImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { try { importState(JSON.parse(String(reader.result))); setMessage("Workspace restored successfully."); } catch { setMessage("That file is not a valid Evolvra backup."); } };
    reader.readAsText(file); event.target.value = "";
  };
  const eraseEverything = async () => {
    if (user) {
      const supabase = getSupabase();
      await supabase?.from("workspace_snapshots").delete().eq("user_id", user.id);
      await supabase?.rpc("delete_my_account");
      await signOut();
    }
    resetWorkspace();
    setDangerOpen(false);
  };

  return <div>
    <section className="page-header"><div><p className="eyebrow">Make the system yours</p><h1>Customise Evolvra</h1><p className="page-lead">Your language, structure, scoring, appearance, and data stay under your control.</p></div></section>
    <div className="settings-layout">
      <nav className="settings-nav panel">{sections.map(({ id, label, icon: Icon }) => <button key={id} className={active === id ? "active" : ""} onClick={() => setActive(id)}><Icon size={17} /><span>{label}</span></button>)}</nav>
      <div className="settings-content">
        {active === "profile" && <Panel><SettingsHead eyebrow="Identity" title="Profile & chapter" description="Shape the context shown across your command centre." /><div className="form-stack"><Field label="Display name"><input value={state.profile.displayName} onChange={(e) => updateProfile({ displayName: e.target.value })} /></Field><Field label="Current chapter" hint="A short description of your main season or objective"><input value={state.profile.chapter} onChange={(e) => updateProfile({ chapter: e.target.value })} /></Field><Field label="Birth date" hint="Used only for the life calendar and age display"><input type="date" value={state.settings.birthDate ?? ""} onChange={(e) => updateSettings({ birthDate: e.target.value || undefined })} /></Field><div className="setting-row"><div><strong>Browser notifications</strong><p>Optional nudges for reviews and planned actions. No guilt-based streak reminders.</p></div><Button variant="secondary" onClick={requestNotifications}><Bell size={16} /> {state.settings.notifications ? "Enabled" : "Enable"}</Button></div></div></Panel>}

        {active === "structure" && <div className="settings-stack">
          <Panel id="areas"><SettingsHead eyebrow="Organisational folders" title={term.areas} description="Create, colour, reorder, hide, or archive the divisions of your life." action={<Button onClick={() => openEdit({ kind: "area" })}><Plus size={15} /> Add area</Button>} /><div className="custom-list">{[...state.areas].sort((a, b) => a.order - b.order).map((area, index) => <div key={area.id} className={area.archived ? "archived" : ""}><span className="custom-icon" style={{ color: area.color, background: `${area.color}18` }}><DynamicIcon name={area.icon} /></span><div><strong>{area.name}</strong><small>{state.goals.filter((goal) => goal.areaId === area.id).length} goals{area.archived ? " · archived" : ""}</small></div><div className="reorder-buttons"><button disabled={index === 0} onClick={() => moveArea(index, -1)}><ArrowUp size={14} /></button><button disabled={index === state.areas.length - 1} onClick={() => moveArea(index, 1)}><ArrowDown size={14} /></button></div><button className="icon-button" onClick={() => openEdit({ kind: "area", value: area })}><Edit3 size={15} /></button><button className="icon-button danger" onClick={() => removeArea(area.id)}><Trash2 size={15} /></button></div>)}</div></Panel>
          <Panel id="stats"><SettingsHead eyebrow="Character attributes" title={term.stats} description="Every stat is editable. Existing XP remains safe when a stat is archived." action={<Button onClick={() => openEdit({ kind: "stat" })}><Plus size={15} /> Add stat</Button>} /><div className="custom-list">{state.stats.map((stat) => <div key={stat.id} className={stat.archived ? "archived" : ""}><span className="custom-icon" style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} /></span><div><strong>{stat.name}</strong><small>{Math.round(stat.xp)} XP{stat.archived ? " · archived" : ""}</small></div><Pill>{state.goals.filter((goal) => goal.statWeights[stat.id]).length} connected</Pill><button className="icon-button" onClick={() => openEdit({ kind: "stat", value: stat })}><Edit3 size={15} /></button><button className="icon-button danger" onClick={() => removeStat(stat.id)}><Trash2 size={15} /></button></div>)}</div></Panel>
        </div>}

        {active === "appearance" && <Panel><SettingsHead eyebrow="Visual direction" title="Appearance" description="Choose a calm interface or increase the character-system atmosphere." /><div className="settings-group"><h3>Theme</h3><div className="option-cards thirds">{([{ id: "dark", label: "Dark", icon: Moon }, { id: "light", label: "Light", icon: Sun }, { id: "system", label: "System", icon: Monitor }] as const).map(({ id, label, icon: Icon }) => <button key={id} className={state.settings.theme === id ? "active" : ""} onClick={() => updateSettings({ theme: id })}><Icon /><strong>{label}</strong>{state.settings.theme === id && <Check />}</button>)}</div></div><div className="settings-group"><h3>Game element intensity</h3><div className="option-cards">{([{ id: "minimal", label: "Minimal", body: "Clean productivity language and subdued visual effects." }, { id: "balanced", label: "Balanced", body: "Stats, XP, and light RPG atmosphere without distraction." }, { id: "immersive", label: "Immersive", body: "Stronger glows, level moments, and command-centre character." }] as const).map((item) => <button key={item.id} className={state.settings.gameIntensity === item.id ? "active" : ""} onClick={() => updateSettings({ gameIntensity: item.id })}><strong>{item.label}</strong><p>{item.body}</p>{state.settings.gameIntensity === item.id && <Check />}</button>)}</div></div></Panel>}

        {active === "language" && <Panel><SettingsHead eyebrow="Your words" title="Terminology" description="Rename the main concepts globally so the system feels natural to you." /><div className="form-grid">{Object.entries(term).map(([key, value]) => <Field key={key} label={`Default: ${key[0].toUpperCase()}${key.slice(1)}`}><input value={value} onChange={(e) => updateSettings({ terminology: { ...term, [key]: e.target.value } })} /></Field>)}</div><div className="setting-note"><Sparkles size={17} /><p>Examples: Goals → Missions, Quests → Actions, Areas → Realms, Milestones → Chapters, Stats → Attributes.</p></div></Panel>}

        {active === "scoring" && <Panel><SettingsHead eyebrow="Transparent rules" title="Scoring & levels" description="Change the defaults. Every quest still shows its score before it is accepted." /><div className="scoring-groups"><ScoringGroup title="Effort XP" values={state.settings.scoring.effort} onChange={(key, value) => setScoring("effort", key, value)} /><ScoringGroup title="Difficulty bonus" values={state.settings.scoring.difficulty} onChange={(key, value) => setScoring("difficulty", key, value)} /><ScoringGroup title="Impact bonus" values={state.settings.scoring.impact} onChange={(key, value) => setScoring("impact", key, value)} /></div><div className="form-grid thirds"><Field label="Normal quest cap"><input type="number" value={state.settings.scoring.questCap} onChange={(e) => setScoring("questCap", Number(e.target.value))} /></Field><Field label="Level base XP"><input type="number" value={state.settings.scoring.levelBase} onChange={(e) => setScoring("levelBase", Number(e.target.value))} /></Field><Field label="Growth per level"><input type="number" value={state.settings.scoring.levelGrowth} onChange={(e) => setScoring("levelGrowth", Number(e.target.value))} /></Field></div><div className="formula-card"><span>Current level formula</span><code>XP needed = {state.settings.scoring.levelBase} + (current level × {state.settings.scoring.levelGrowth})</code><small>Levels and XP remain permanent. No missed action can reduce them.</small></div></Panel>}

        {active === "sync" && <Panel><SettingsHead eyebrow="Private by design" title="Sync & privacy" description="The app works locally first. Supabase adds private cross-device sync when you choose." /><div className={`cloud-status ${user ? "connected" : ""}`}><span>{user ? <Cloud /> : <HardDrive />}</span><div><strong>{user ? `Synced as ${user.email}` : "Stored privately on this device"}</strong><p>{user ? `Status: ${syncStatus}. Changes are saved to your protected workspace.` : "No account is required for local use. Export backups whenever you like."}</p></div>{user && <Button variant="secondary" onClick={signOut}><LogOut size={15} /> Sign out</Button>}</div>{!user && <div className="sync-form"><Field label="Email address" hint={cloudEnabled ? "We will send a secure magic link — no password needed." : "Add Supabase keys to .env.local before connecting."}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></Field><Button disabled={!email || !cloudEnabled} onClick={async () => { try { setMessage(await signIn(email)); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not connect."); } }}><Cloud size={16} /> Connect private sync</Button></div>}<div className="privacy-list"><div><ShieldCheck /><span><strong>Row-level security</strong><small>Every cloud record is restricted to the signed-in account.</small></span></div><div><Save /><span><strong>Local-first persistence</strong><small>Your current workspace stays available even without a connection.</small></span></div><div><RotateCcw /><span><strong>Recoverable edits</strong><small>Recent snapshots power the Undo control and backup restore.</small></span></div></div></Panel>}

        {active === "data" && <Panel><SettingsHead eyebrow="Ownership & recovery" title="Your data" description="Export everything, restore a snapshot, or erase the workspace completely." /><div className="data-actions"><button onClick={exportJson}><span><Download /></span><div><strong>Full JSON backup</strong><p>Every goal, stat, review, setting, and event in a restorable file.</p></div></button><button onClick={exportCsv}><span><Download /></span><div><strong>Timeline CSV</strong><p>A spreadsheet-ready history of your recorded development.</p></div></button><button onClick={() => importRef.current?.click()}><span><Upload /></span><div><strong>Restore from backup</strong><p>Import a previous Evolvra JSON file. You can undo the import.</p></div></button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={onImport} /></div><div className="danger-zone"><div><strong>Erase this workspace</strong><p>Delete local data, cloud snapshots, and the connected account. Export a backup first.</p></div><Button variant="danger" onClick={() => setDangerOpen(true)}><Trash2 size={15} /> Erase everything</Button></div></Panel>}

        {message && <div className="toast-message"><Check size={16} />{message}<button onClick={() => setMessage("")}>×</button></div>}
      </div>
    </div>

    <Modal open={Boolean(editItem)} onClose={() => setEditItem(null)} eyebrow={editItem?.kind === "area" ? "Life structure" : "Character growth"} title={`${editItem?.value ? "Edit" : "Add"} ${editItem?.kind ?? "item"}`}><div className="form-stack"><Field label="Name"><input autoFocus value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder={editItem?.kind === "area" ? "Creative work" : "Leadership"} /></Field><div className="form-grid"><Field label="Colour"><div className="color-input"><input type="color" value={itemColor} onChange={(e) => setItemColor(e.target.value)} /><input value={itemColor} onChange={(e) => setItemColor(e.target.value)} /></div></Field><Field label="Icon"><select value={itemIcon} onChange={(e) => setItemIcon(e.target.value)}>{ICON_OPTIONS.map((icon) => <option key={icon}>{icon}</option>)}</select></Field></div><div className="icon-preview" style={{ color: itemColor, background: `${itemColor}18` }}><DynamicIcon name={itemIcon} size={24} /><strong>{itemName || "Preview"}</strong></div><div className="button-row end"><Button variant="ghost" onClick={() => setEditItem(null)}>Cancel</Button><Button disabled={!itemName.trim()} onClick={saveItem}><Save size={15} /> Save</Button></div></div></Modal>
    <Modal open={dangerOpen} onClose={() => setDangerOpen(false)} eyebrow="Permanent action" title="Erase your Evolvra workspace?"><div className="danger-confirm"><span><Trash2 /></span><p>This removes all local information and, if connected, your cloud snapshot and account. This action cannot be undone after this page reloads.</p><div className="button-row end"><Button variant="ghost" onClick={() => setDangerOpen(false)}>Keep my data</Button><Button variant="danger" onClick={eraseEverything}>Erase everything</Button></div></div></Modal>
  </div>;
}

function SettingsHead({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="settings-head"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}

function ScoringGroup({ title, values, onChange }: { title: string; values: Record<string, number>; onChange: (key: string, value: number) => void }) {
  return <div><h3>{title}</h3>{Object.entries(values).map(([key, value]) => <label key={key}><span>{key}</span><input type="number" min="0" value={value} onChange={(e) => onChange(key, Number(e.target.value))} /></label>)}</div>;
}
