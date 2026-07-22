"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowUp, CalendarDays, Check, CheckCircle2, Circle, Download, Edit3, Eye, FileText, Flag, MoreHorizontal, Pause, Play, Plus, Save, Sparkles, Target, Trash2 } from "lucide-react";
import { remoteEvidencePath, useApp } from "@/components/app-provider";
import { DynamicIcon } from "@/components/icons";
import { QuestForm } from "@/components/quest-form";
import { QuestCompletionForm } from "@/components/quest-completion-form";
import { MetricHistoryChart } from "@/components/metric-history-chart";
import { Button, EmptyState, Field, FieldGroup, Modal, Panel, Pill, ProgressBar } from "@/components/ui";
import { completionGoalIds } from "@/lib/activity-attribution";
import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  goalEvidenceFromText,
  isAllowedEvidenceMimeType,
  isValidEvidenceFileName,
  MAX_EVIDENCE_FILE_SIZE,
  MAX_GOAL_EVIDENCE_ITEMS,
  normalizeEvidenceMimeType,
  normalizedEvidenceBlob,
} from "@/lib/goal-evidence";
import { deleteEvidenceBlob, readEvidenceBlob, storeEvidenceBlob } from "@/lib/persistence";
import { WORKSPACE_TEXT_LIMITS } from "@/lib/state-schema";
import { getSupabase } from "@/lib/supabase";
import type { ConsistencyPeriod, GoalEvidence, GoalFileEvidence, GoalModel, Milestone, Priority, ProgressMetric, TimelineEvent } from "@/lib/types";
import { activePeriodKey, formatDate, getArea, goalProgress, isFiniteWorkspaceNumber, isQuestAvailable, MAX_WORKSPACE_NUMBER, rollMetricPeriod, singularizeTerm, uid } from "@/lib/utils";

interface EvidencePreview {
  name: string;
  mimeType: string;
  blob: Blob;
  objectUrl?: string;
  text?: string;
}

const evidenceAccountId = (userId?: string) => userId ?? "anonymous";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const nearInstant = (left: string, right: string) => {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= 1_000;
};

export default function GoalDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const {
    state,
    user,
    cloudWriteAllowed,
    workspaceScopeKey,
    persistenceScopeGeneration,
    runWorkspaceFileOperation,
    setGoalFileEvidence,
    updateGoal,
    setGoalStatus,
    deleteGoal,
    toggleMilestone,
    updateMetric,
    addCheckIn,
  } = useApp();
  const goal = state.goals.find((item) => item.id === params.id);
  const [questOpen, setQuestOpen] = useState(false);
  const [editingQuestId, setEditingQuestId] = useState<string | null>(null);
  const [completionQuestId, setCompletionQuestId] = useState<string | null>(null);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneWeight, setMilestoneWeight] = useState(10);
  const [milestoneError, setMilestoneError] = useState("");
  const [metricOpen, setMetricOpen] = useState(false);
  const [editingMetricId, setEditingMetricId] = useState<string | null>(null);
  const [metricLabel, setMetricLabel] = useState("");
  const [metricTarget, setMetricTarget] = useState(100);
  const [metricUnit, setMetricUnit] = useState("");
  const [metricWeight, setMetricWeight] = useState(100);
  const [metricPeriod, setMetricPeriod] = useState<ConsistencyPeriod>("month");
  const [metricError, setMetricError] = useState("");
  const [goalEditOpen, setGoalEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAreaId, setEditAreaId] = useState("");
  const [editPriority, setEditPriority] = useState<Priority>("medium");
  const [editModel, setEditModel] = useState<GoalModel>("numeric");
  const [editTargetDate, setEditTargetDate] = useState("");
  const [editStatIds, setEditStatIds] = useState<string[]>([]);
  const [notes, setNotes] = useState(goal?.notes ?? "");
  const [evidence, setEvidence] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceMessage, setEvidenceMessage] = useState("");
  const [evidencePreview, setEvidencePreview] = useState<EvidencePreview | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [visibleCheckIns, setVisibleCheckIns] = useState(6);
  const [visibleActivity, setVisibleActivity] = useState(12);
  const [analysisNow] = useState(() => Date.now());
  const evidenceInput = useRef<HTMLInputElement>(null);
  const previewObjectUrl = useRef<string | null>(null);
  const previewReturnFocus = useRef<HTMLElement | null>(null);
  const terms = state.settings.terminology;
  const goalTerm = singularizeTerm(terms.goals);
  const questTerm = singularizeTerm(terms.quests);
  const areaTerm = singularizeTerm(terms.areas);
  const milestoneTerm = singularizeTerm(terms.milestones);
  const evidenceWorkspaceBlocked = Boolean(user && !cloudWriteAllowed);

  useEffect(() => () => {
    if (previewObjectUrl.current) URL.revokeObjectURL(previewObjectUrl.current);
  }, []);

  if (!goal) return <EmptyState icon={<Target />} title={`${goalTerm} not found`} body="It may have been removed or is no longer available on this device." action={<Link href="/goals" className="button button-secondary">Back to {terms.goals.toLowerCase()}</Link>} />;

  const area = getArea(state, goal.areaId);
  const progress = goalProgress(goal);
  const sharedQuests = state.goals.flatMap((primaryGoal) => primaryGoal.id === goal.id
    ? []
    : primaryGoal.quests
      .filter((quest) => quest.linkedGoalIds.includes(goal.id))
      .map((quest) => ({ primaryGoal, quest })));
  const canonicalActivity: TimelineEvent[] = [
    ...state.questCompletions.filter((item) => completionGoalIds(item).includes(goal.id)).map((completion) => {
      const primaryGoal = state.goals.find((item) => item.id === completion.goalId);
      return {
        id: `completion-${completion.id}`,
        type: "quest" as const,
        title: completion.title,
        detail: completion.goalId === goal.id
          ? "Action completion retained in the permanent record."
          : `Shared action whose primary home is ${primaryGoal?.title ?? `another ${goalTerm.toLowerCase()}`}.`,
        at: completion.completedAt,
        goalId: completion.goalId,
        areaId: primaryGoal?.areaId,
      };
    }),
    ...state.metricEntries.filter((item) => item.goalId === goal.id).map((entry) => {
      const metric = goal.metrics.find((item) => item.id === entry.metricId);
      const label = entry.label || metric?.label || "Measurement";
      const unit = entry.unit ?? metric?.unit ?? "";
      return { id: `metric-${entry.id}`, type: "metric" as const, title: `${label} updated`, detail: `${entry.previousValue.toLocaleString()} → ${entry.value.toLocaleString()}${unit ? ` ${unit}` : ""}`, at: entry.recordedAt, goalId: goal.id, areaId: goal.areaId };
    }),
    ...goal.milestones.filter((milestone) => milestone.completedAt).map((milestone) => ({ id: `milestone-${milestone.id}`, type: "milestone" as const, title: milestone.title, detail: `${milestoneTerm} reached.`, at: milestone.completedAt!, goalId: goal.id, areaId: goal.areaId })),
    ...goal.checkIns.map((item) => ({ id: `check-in-${item.id}`, type: "note" as const, title: `Check-in for ${goal.title}`, detail: item.note, at: item.createdAt, goalId: goal.id, areaId: goal.areaId })),
    ...(goal.completedAt ? [{ id: `goal-completed-${goal.id}`, type: "goal" as const, title: `${goal.title} completed`, detail: `${goalTerm} completion retained in the permanent record.`, at: goal.completedAt, goalId: goal.id, areaId: goal.areaId }] : []),
  ];
  const structuralActivity = state.timeline.filter((event) => event.goalId === goal.id && !canonicalActivity.some((record) => record.type === event.type && nearInstant(record.at, event.at)));
  const activity = [...canonicalActivity, ...structuralActivity].sort((left, right) => right.at.localeCompare(left.at));
  const goalCompletions = state.questCompletions.filter((item) => completionGoalIds(item).includes(goal.id));
  const completedQuests = goalCompletions.length;
  const recentCompletions = goalCompletions.filter((item) => analysisNow - new Date(item.completedAt).getTime() < 30 * 86_400_000);
  const previousCompletions = goalCompletions.filter((item) => {
    const age = analysisNow - new Date(item.completedAt).getTime();
    return age >= 30 * 86_400_000 && age < 60 * 86_400_000;
  });
  const totalMinutes = goalCompletions.reduce((sum, item) => sum + (item.durationMinutes ?? 0), 0);
  const totalWeight = goal.milestones.reduce((sum, milestone) => sum + milestone.weight, 0);

  const addMilestone = () => {
    if (!milestoneTitle.trim()) return;
    const otherWeight = goal.milestones
      .filter((item) => item.id !== editingMilestoneId)
      .reduce((sum, item) => sum + item.weight, 0);
    if (goal.model === "weighted" && (!isFiniteWorkspaceNumber(milestoneWeight, 0, 100) || otherWeight + milestoneWeight > 100)) {
      setMilestoneError(`Weighted ${terms.milestones.toLowerCase()} cannot exceed 100%. ${Math.max(0, 100 - otherWeight)}% remains available.`);
      return;
    }
    const milestone: Milestone = { id: uid("milestone"), title: milestoneTitle.trim(), weight: goal.model === "weighted" ? milestoneWeight : 0, completed: false };
    const milestones = editingMilestoneId
      ? goal.milestones.map((item) => item.id === editingMilestoneId ? { ...item, title: milestone.title, weight: milestone.weight } : item)
      : [...goal.milestones, milestone];
    updateGoal(goal.id, { milestones });
    setMilestoneOpen(false); setEditingMilestoneId(null); setMilestoneTitle(""); setMilestoneWeight(10);
  };

  const openMilestone = (milestone?: Milestone) => {
    setEditingMilestoneId(milestone?.id ?? null);
    setMilestoneTitle(milestone?.title ?? "");
    setMilestoneWeight(milestone?.weight ?? 10);
    setMilestoneError("");
    setMilestoneOpen(true);
  };

  const openMetric = (metric?: ProgressMetric) => {
    setEditingMetricId(metric?.id ?? null);
    setMetricLabel(metric?.label ?? "");
    setMetricTarget(metric?.target ?? 100);
    setMetricUnit(metric?.unit ?? "");
    setMetricWeight(metric?.weight ?? (goal.metrics.length ? 50 : 100));
    setMetricPeriod(metric?.period ?? "month");
    setMetricError("");
    setMetricOpen(true);
  };

  const saveMetric = () => {
    if (!metricLabel.trim() || !isFiniteWorkspaceNumber(metricTarget, Number.MIN_VALUE) || !isFiniteWorkspaceNumber(metricWeight, 0, 100)) {
      setMetricError("Use a finite target and a relative weight from 0 to 100.");
      return;
    }
    const existing = goal.metrics.find((item) => item.id === editingMetricId);
    const periodChanged = goal.model === "consistency" && existing?.period !== metricPeriod;
    const metric: ProgressMetric = {
      id: existing?.id ?? uid("metric"),
      label: metricLabel.trim(),
      current: periodChanged ? 0 : existing?.current ?? 0,
      target: metricTarget,
      unit: metricUnit.trim(),
      weight: Math.max(0, Math.min(100, metricWeight)),
      ...(goal.model === "consistency" ? { period: metricPeriod, periodKey: activePeriodKey(metricPeriod) } : {}),
    };
    const metrics = existing
      ? goal.metrics.map((item) => item.id === existing.id ? metric : item)
      : [...goal.metrics, metric];
    if (
      (goal.model === "numeric" || goal.model === "consistency")
      && !metrics.some((item) => item.weight > 0)
    ) {
      setMetricError("Keep at least one metric with a positive relative weight.");
      return;
    }
    updateGoal(goal.id, { metrics });
    setMetricOpen(false); setEditingMetricId(null); setMetricLabel(""); setMetricTarget(100); setMetricUnit(""); setMetricWeight(100); setMetricPeriod("month");
  };

  const deleteMetric = (metric: ProgressMetric) => {
    const metrics = goal.metrics.filter((item) => item.id !== metric.id);
    if (
      (goal.model === "numeric" || goal.model === "consistency")
      && (!metrics.length || !metrics.some((item) => item.weight > 0))
    ) {
      setEvidenceMessage("A measured goal needs at least one metric with a positive relative weight. Add or reweight another metric first.");
      return;
    }
    if (!window.confirm(`Delete ${metric.label}? Its recorded history will remain in the timeline.`)) return;
    updateGoal(goal.id, {
      metrics,
      quests: goal.quests.map((quest) => ({
        ...quest,
        metricDeltas: quest.metricDeltas.filter((delta) => delta.metricId !== metric.id),
      })),
    });
  };

  const openGoalEdit = () => {
    setEditTitle(goal.title); setEditDescription(goal.description); setEditAreaId(goal.areaId); setEditPriority(goal.priority);
    setEditModel(goal.model); setEditTargetDate(goal.targetDate ?? ""); setEditStatIds(goal.statIds); setGoalEditOpen(true); setMenuOpen(false);
  };

  const saveGoalEdit = () => {
    if (!editTitle.trim() || !editDescription.trim() || !editAreaId) return;
    const metrics = goal.metrics.map((metric) => {
      if (editModel === "consistency") {
        const period = metric.period ?? "month";
        return { ...metric, period, periodKey: metric.periodKey ?? activePeriodKey(period) };
      }
      const { period: _period, periodKey: _periodKey, ...unscopedMetric } = metric;
      void _period;
      void _periodKey;
      return unscopedMetric;
    });
    updateGoal(goal.id, { title: editTitle.trim(), description: editDescription.trim(), areaId: editAreaId, model: editModel, priority: editPriority, targetDate: editTargetDate || undefined, statIds: editStatIds, metrics });
    setGoalEditOpen(false);
  };

  const reorder = <T,>(items: T[], index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  };

  const closeEvidencePreview = () => {
    const returnFocus = previewReturnFocus.current;
    previewReturnFocus.current = null;
    if (previewObjectUrl.current) {
      URL.revokeObjectURL(previewObjectUrl.current);
      previewObjectUrl.current = null;
    }
    setEvidencePreview(null);
    window.requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    });
  };

  const resolveEvidenceBlob = async (meta: GoalFileEvidence) => {
    if (!isAllowedEvidenceMimeType(meta.mimeType)) {
      throw new Error("This evidence type is not allowed for preview or download.");
    }
    const accountId = evidenceAccountId(user?.id);
    let record = await readEvidenceBlob(
      accountId,
      goal.id,
      meta.id,
      persistenceScopeGeneration,
    );
    if (record && !normalizedEvidenceBlob(record.blob, meta)) {
      await deleteEvidenceBlob(accountId, goal.id, meta.id, persistenceScopeGeneration);
      record = null;
    }
    if (!record && user && meta.remotePath) {
      const safeRemotePath = remoteEvidencePath(meta, user.id, goal.id);
      if (!safeRemotePath) throw new Error("This file's private cloud reference is invalid and was not opened.");
      const supabase = await getSupabase();
      const { data, error } = await supabase?.storage.from("evidence").download(safeRemotePath)
        ?? { data: null, error: new Error("Cloud storage is unavailable.") };
      if (error || !data) throw error ?? new Error("The private file could not be downloaded.");
      const verified = normalizedEvidenceBlob(data, meta);
      if (!verified) throw new Error("The private cloud file did not match its recorded type and size, so it was not cached or opened.");
      record = await storeEvidenceBlob(
        { accountId, goalId: goal.id, evidenceId: meta.id, blob: verified },
        persistenceScopeGeneration,
      );
    }
    if (!record) throw new Error("This file is not available on the current device and has no cloud copy.");
    const verified = normalizedEvidenceBlob(record.blob, meta);
    if (!verified) throw new Error("The device copy did not match its recorded type and size and was removed for safety.");
    return verified;
  };

  const addEvidenceFile = async (file?: File) => {
    if (!file || evidenceBusy) return;
    if (evidenceWorkspaceBlocked) {
      setEvidenceMessage("Finish the pending workspace or sync choice before changing evidence files.");
      return;
    }
    if (goal.evidence.length >= MAX_GOAL_EVIDENCE_ITEMS) {
      setEvidenceMessage(`A ${goalTerm.toLowerCase()} can contain at most ${MAX_GOAL_EVIDENCE_ITEMS} evidence items.`);
      return;
    }
    const evidenceName = file.name.trim();
    if (!isValidEvidenceFileName(evidenceName)) {
      setEvidenceMessage("Use a non-empty file name no longer than 255 characters and without control characters.");
      return;
    }
    if (file.size > MAX_EVIDENCE_FILE_SIZE) {
      setEvidenceMessage("Choose a file no larger than 10 MB.");
      return;
    }
    const mimeType = normalizeEvidenceMimeType(file.type);
    if (!isAllowedEvidenceMimeType(mimeType)) {
      setEvidenceMessage("Use a JPEG, PNG, WebP, PDF, or plain-text file.");
      return;
    }
    const verifiedFile = normalizedEvidenceBlob(file, { mimeType, size: file.size });
    if (!verifiedFile) {
      setEvidenceMessage("The selected file metadata could not be verified.");
      return;
    }
    setEvidenceBusy(true);
    setEvidenceMessage("");
    const id = uid("evidence");
    const accountId = evidenceAccountId(user?.id);
    const operationScopeKey = workspaceScopeKey;
    try {
      await runWorkspaceFileOperation(operationScopeKey, async () => {
        let localStored = false;
        let uploadedPath: string | undefined;
        let metadataCommitted = false;
        try {
          await storeEvidenceBlob(
            { accountId, goalId: goal.id, evidenceId: id, blob: verifiedFile },
            persistenceScopeGeneration,
          );
          localStored = true;
          if (user) {
            const supabase = await getSupabase();
            const safeName = evidenceName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-120) || "evidence";
            const path = `${user.id}/${goal.id}/${id}/${safeName}`;
            const { error } = await supabase?.storage.from("evidence").upload(path, verifiedFile, { contentType: mimeType, upsert: false }) ?? { error: new Error("Cloud storage is unavailable.") };
            if (!error) uploadedPath = path;
            else setEvidenceMessage("The file is safe on this device, but its private cloud upload will need to be retried from this device.");
          }
          await setGoalFileEvidence(goal.id, [
            ...goal.evidence,
            {
              id,
              type: "file",
              name: evidenceName,
              mimeType,
              size: file.size,
              ...(uploadedPath ? { remotePath: uploadedPath } : {}),
            },
          ], operationScopeKey);
          metadataCommitted = true;
        } catch (error) {
          if (!metadataCommitted) {
            if (uploadedPath && user) {
              const supabase = await getSupabase();
              await supabase?.storage.from("evidence").remove([uploadedPath]);
            }
            if (localStored) {
              await deleteEvidenceBlob(
                accountId,
                goal.id,
                id,
                persistenceScopeGeneration,
              );
            }
          }
          throw error;
        }
      });
    } catch (error) {
      setEvidenceMessage(error instanceof Error ? error.message : "The file could not be stored safely.");
    } finally {
      setEvidenceBusy(false);
    }
  };

  const previewEvidenceFile = async (meta: GoalFileEvidence) => {
    if (evidenceBusy) return;
    if (evidenceWorkspaceBlocked) {
      setEvidenceMessage("Finish the pending workspace or sync choice before opening account-scoped evidence files.");
      return;
    }
    previewReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEvidenceBusy(true);
    setEvidenceMessage("");
    const operationScopeKey = workspaceScopeKey;
    try {
      await runWorkspaceFileOperation(operationScopeKey, async () => {
        const blob = await resolveEvidenceBlob(meta);
        if (previewObjectUrl.current) URL.revokeObjectURL(previewObjectUrl.current);
        previewObjectUrl.current = null;
        if (meta.mimeType === "text/plain") {
          setEvidencePreview({ name: meta.name, mimeType: meta.mimeType, blob, text: await blob.text() });
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        previewObjectUrl.current = objectUrl;
        setEvidencePreview({ name: meta.name, mimeType: meta.mimeType, blob, objectUrl });
      });
    } catch (error) {
      previewReturnFocus.current = null;
      setEvidenceMessage(error instanceof Error ? error.message : "The file preview could not be opened.");
    } finally {
      setEvidenceBusy(false);
    }
  };

  const downloadEvidenceFile = async (meta: GoalFileEvidence) => {
    if (evidenceBusy) return;
    if (evidenceWorkspaceBlocked) {
      setEvidenceMessage("Finish the pending workspace or sync choice before downloading account-scoped evidence files.");
      return;
    }
    setEvidenceBusy(true);
    setEvidenceMessage("");
    const operationScopeKey = workspaceScopeKey;
    try {
      await runWorkspaceFileOperation(operationScopeKey, async () => {
        downloadBlob(await resolveEvidenceBlob(meta), meta.name);
      });
    } catch (error) {
      setEvidenceMessage(error instanceof Error ? error.message : "The file could not be downloaded.");
    } finally {
      setEvidenceBusy(false);
    }
  };

  const syncEvidenceFile = async (meta: GoalFileEvidence) => {
    if (!user || evidenceBusy) return;
    if (!cloudWriteAllowed) {
      setEvidenceMessage("Finish the pending workspace or sync choice before uploading evidence.");
      return;
    }
    setEvidenceBusy(true);
    setEvidenceMessage("");
    const operationScopeKey = workspaceScopeKey;
    try {
      await runWorkspaceFileOperation(operationScopeKey, async () => {
        const record = await readEvidenceBlob(
          evidenceAccountId(user.id),
          goal.id,
          meta.id,
          persistenceScopeGeneration,
        );
        if (!record) throw new Error("Open this file on the device where it was added before retrying its cloud upload.");
        const verifiedBlob = normalizedEvidenceBlob(record.blob, meta);
        if (!verifiedBlob) {
          await deleteEvidenceBlob(
            evidenceAccountId(user.id),
            goal.id,
            meta.id,
            persistenceScopeGeneration,
          );
          throw new Error("The device copy did not match its recorded type and size, so it was removed instead of uploaded.");
        }
        const supabase = await getSupabase();
        const safeName = meta.name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-120) || "evidence";
        const safeRemotePath = `${user.id}/${goal.id}/${meta.id}/${safeName}`;
        const bucket = supabase?.storage.from("evidence");
        if (!bucket) throw new Error("Cloud storage is unavailable.");
        const { error } = await bucket.upload(safeRemotePath, verifiedBlob, { contentType: meta.mimeType, upsert: false });
        let createdRemote = !error;
        if (error) {
          // A previous retry may already have completed remotely. Adopt it only
          // after exact byte metadata validation; never overwrite it blindly.
          const existing = await bucket.download(safeRemotePath);
          if (existing.error || !existing.data || !normalizedEvidenceBlob(existing.data, meta)) throw error;
          createdRemote = false;
        }
        try {
          await setGoalFileEvidence(goal.id, goal.evidence.map((value) => value.id === meta.id
            ? { ...meta, remotePath: safeRemotePath }
            : value), operationScopeKey);
        } catch (error) {
          if (createdRemote) await bucket.remove([safeRemotePath]);
          throw error;
        }
        setEvidenceMessage("Private cloud copy saved.");
      });
    } catch (error) {
      setEvidenceMessage(error instanceof Error ? error.message : "The private cloud upload could not be completed.");
    } finally {
      setEvidenceBusy(false);
    }
  };

  const removeEvidence = async (item: GoalEvidence) => {
    if (evidenceBusy) return;
    if (item.type !== "file") {
      updateGoal(goal.id, { evidence: goal.evidence.filter((value) => value.id !== item.id) });
      return;
    }
    if (evidenceWorkspaceBlocked) {
      setEvidenceMessage("Finish the pending workspace or sync choice before removing evidence files.");
      return;
    }
    setEvidenceBusy(true);
    setEvidenceMessage("");
    const operationScopeKey = workspaceScopeKey;
    try {
      await runWorkspaceFileOperation(operationScopeKey, async () => {
        const accountId = evidenceAccountId(user?.id);
        const backup = await resolveEvidenceBlob(item);
        const safeRemotePath = user && item.remotePath
          ? remoteEvidencePath(item, user.id, goal.id)
          : undefined;
        const supabase = safeRemotePath ? await getSupabase() : null;
        const bucket = supabase?.storage.from("evidence");
        let remoteRemoved = false;
        let localRemoved = false;
        let metadataCommitted = false;
        try {
          await setGoalFileEvidence(
            goal.id,
            goal.evidence.filter((value) => value.id !== item.id),
            operationScopeKey,
          );
          metadataCommitted = true;
          if (safeRemotePath) {
            if (!bucket) throw new Error("Cloud storage is unavailable.");
            const { error } = await bucket.remove([safeRemotePath]);
            if (error) throw error;
            remoteRemoved = true;
          }
          await deleteEvidenceBlob(
            accountId,
            goal.id,
            item.id,
            persistenceScopeGeneration,
          );
          localRemoved = true;
        } catch (error) {
          const rollbackFailures: unknown[] = [];
          if (localRemoved) {
            try {
              await storeEvidenceBlob(
                { accountId, goalId: goal.id, evidenceId: item.id, blob: backup },
                persistenceScopeGeneration,
              );
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
          }
          if (remoteRemoved && safeRemotePath && bucket) {
            try {
              const restored = await bucket.upload(safeRemotePath, backup, {
                contentType: item.mimeType,
                upsert: false,
              });
              if (restored.error) {
                const existing = await bucket.download(safeRemotePath);
                if (existing.error || !existing.data || !normalizedEvidenceBlob(existing.data, item)) {
                  throw restored.error;
                }
              }
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
          }
          if (metadataCommitted) {
            try {
              await setGoalFileEvidence(goal.id, goal.evidence, operationScopeKey);
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
          }
          if (rollbackFailures.length) {
            throw new AggregateError([error, ...rollbackFailures], "Evidence removal failed and one or more storage copies could not be restored.");
          }
          throw error;
        }
      });
    } catch (error) {
      setEvidenceMessage(error instanceof Error ? error.message : "Evidence could not be removed from every storage location.");
    } finally {
      setEvidenceBusy(false);
    }
  };

  const renameEvidenceFile = async (meta: GoalFileEvidence) => {
    if (evidenceBusy) return;
    if (evidenceWorkspaceBlocked) {
      setEvidenceMessage("Finish the pending workspace or sync choice before renaming evidence files.");
      return;
    }
    const requested = window.prompt("Rename this evidence file", meta.name)?.trim();
    if (!requested || requested === meta.name) return;
    if (!isValidEvidenceFileName(requested)) {
      setEvidenceMessage("Use a non-empty file name no longer than 255 characters and without control characters.");
      return;
    }
    setEvidenceBusy(true);
    setEvidenceMessage("");
    const operationScopeKey = workspaceScopeKey;
    try {
      await runWorkspaceFileOperation(operationScopeKey, async () => {
        const originalRemotePath = user && meta.remotePath
          ? remoteEvidencePath(meta, user.id, goal.id)
          : undefined;
        let nextRemotePath = originalRemotePath;
        let candidateCreated = false;
        let bucket: ReturnType<NonNullable<ReturnType<typeof getSupabase>>["storage"]["from"]> | null = null;
        if (user && originalRemotePath) {
          const safeName = requested.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-120) || "evidence";
          const candidatePath = `${originalRemotePath.slice(0, originalRemotePath.lastIndexOf("/") + 1)}${safeName}`;
          if (candidatePath !== originalRemotePath) {
            const supabase = await getSupabase();
            bucket = supabase?.storage.from("evidence") ?? null;
            if (!bucket) throw new Error("Cloud storage is unavailable.");
            const blob = await resolveEvidenceBlob(meta);
            const uploaded = await bucket.upload(candidatePath, blob, {
              contentType: meta.mimeType,
              upsert: false,
            });
            if (uploaded.error) {
              const existing = await bucket.download(candidatePath);
              if (existing.error || !existing.data || !normalizedEvidenceBlob(existing.data, meta)) {
                throw uploaded.error;
              }
            } else {
              candidateCreated = true;
            }
            nextRemotePath = candidatePath;
          }
        }
        try {
          await setGoalFileEvidence(goal.id, goal.evidence.map((value) => value.id === meta.id
            ? { ...meta, name: requested, ...(nextRemotePath ? { remotePath: nextRemotePath } : {}) }
            : value), operationScopeKey);
          if (bucket && originalRemotePath && nextRemotePath && nextRemotePath !== originalRemotePath) {
            const removed = await bucket.remove([originalRemotePath]);
            if (removed.error) {
              await setGoalFileEvidence(goal.id, goal.evidence, operationScopeKey);
              throw removed.error;
            }
          }
        } catch (error) {
          if (candidateCreated && bucket && nextRemotePath && nextRemotePath !== originalRemotePath) {
            await bucket.remove([nextRemotePath]);
          }
          throw error;
        }
        setEvidenceMessage("Evidence file renamed.");
      });
    } catch (error) {
      setEvidenceMessage(error instanceof Error ? error.message : "The evidence file could not be renamed everywhere.");
    } finally {
      setEvidenceBusy(false);
    }
  };

  return <div className="goal-detail">
    <Link href="/goals" className="back-link"><ArrowLeft size={16} /> All {terms.goals.toLowerCase()}</Link>
    <section className="goal-detail-hero panel" style={{ "--goal-color": area?.color } as React.CSSProperties}>
      <div className="goal-hero-main">
        <span className="goal-hero-icon" style={{ color: area?.color, background: `${area?.color}18` }}><DynamicIcon name={area?.icon ?? "Target"} size={25} /></span>
        <div><div className="goal-kicker"><span style={{ color: area?.color }}>{area?.name}</span><Pill>{goal.model}</Pill><Pill>{goal.status}</Pill></div><h1>{goal.title}</h1><p>{goal.description}</p><div className="goal-hero-meta"><span><Flag size={14} /> {goal.priority} importance</span>{goal.targetDate && <span><CalendarDays size={14} /> Target {formatDate(goal.targetDate)}</span>}<span>Created {formatDate(goal.createdAt)}</span></div></div>
      </div>
      <div className="goal-hero-actions">
        {goal.status === "active" ? <Button variant="secondary" onClick={() => setGoalStatus(goal.id, "paused")}><Pause size={16} /> Pause</Button> : goal.status === "paused" ? <Button variant="secondary" onClick={() => setGoalStatus(goal.id, "active")}><Play size={16} /> Resume</Button> : goal.status === "archived" ? <Button variant="secondary" onClick={() => setGoalStatus(goal.id, "active")}><Play size={16} /> Restore</Button> : goal.status === "completed" ? <Button variant="secondary" onClick={() => setGoalStatus(goal.id, "active")}><Play size={16} /> Reopen</Button> : null}
        {(goal.status === "active" || goal.status === "paused") && <Button onClick={() => setGoalStatus(goal.id, "completed")}><CheckCircle2 size={16} /> Complete {goalTerm.toLowerCase()}</Button>}
        <div className="menu-wrap"><button className="icon-button" aria-label={`More ${goalTerm.toLowerCase()} actions`} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={20} /></button>{menuOpen && <div className="popover-menu"><button onClick={openGoalEdit}><Edit3 size={15} /> Edit {goalTerm.toLowerCase()}</button>{goal.status !== "archived" && <button onClick={() => setGoalStatus(goal.id, "archived")}><FileText size={15} /> Archive</button>}<button className="danger" disabled={evidenceBusy} title={evidenceBusy ? "Wait for the evidence file operation to finish" : undefined} onClick={async () => { if (!window.confirm(`Permanently delete this ${goalTerm.toLowerCase()}, its evidence, and all connected activity history? This cannot be undone.`)) return; try { await deleteGoal(goal.id); router.push("/goals"); } catch (error) { setEvidenceMessage(error instanceof Error ? error.message : `The ${goalTerm.toLowerCase()} could not be removed from every storage location.`); setMenuOpen(false); } }}><Trash2 size={15} /> Permanently delete</button></div>}</div>
      </div>
      <div className="goal-hero-progress">
        <div><span>{progress === null ? "Reflective progress" : "Overall progress"}</span><strong>{progress === null ? (goal.checkIns[0] ? formatDate(goal.checkIns[0].createdAt) : "No check-ins yet") : `${Math.round(progress)}%`}</strong></div>
        {progress === null ? <p className="muted-copy">Describe what changed, what you learned, and what should happen next.</p> : <ProgressBar value={progress} color={area?.color} />}
      </div>
    </section>

    <div className="goal-detail-grid">
      <div className="goal-detail-main">
        <Panel>
          <div className="section-heading"><div><p className="eyebrow">Real-world measurement</p><h2>Progress metrics</h2></div>{goal.model !== "open" && <Button variant="secondary" onClick={() => openMetric()}><Plus size={15} /> Add metric</Button>}</div>
          {goal.model === "open" ? <div className="reflection-stack"><div className="reflection-card"><Sparkles /><div><strong>Progress is reflective</strong><p>This {goalTerm.toLowerCase()} uses dated check-ins and evidence instead of pretending every outcome has a precise percentage.</p></div></div><Field label="New check-in"><textarea rows={3} maxLength={WORKSPACE_TEXT_LIMITS.checkIn} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} placeholder="What changed since the last check-in?" /></Field><div className="button-row end"><Button disabled={!checkIn.trim()} onClick={() => { addCheckIn(goal.id, checkIn); setCheckIn(""); }}><Plus size={15} /> Record check-in</Button></div>{goal.checkIns.length ? <div className="check-in-list">{goal.checkIns.slice(0, visibleCheckIns).map((item) => <div key={item.id}><strong>{formatDate(item.createdAt)}</strong><p>{item.note}</p></div>)}{visibleCheckIns < goal.checkIns.length ? <button className="button button-secondary history-load-more" onClick={() => setVisibleCheckIns((count) => count + 6)}>Load older check-ins ({goal.checkIns.length - visibleCheckIns} remaining)</button> : null}</div> : null}{goal.metrics.length ? <p className="supportive-copy">Existing measurement definitions and history are preserved but do not create a percentage while this {goalTerm.toLowerCase()} uses open reflection.</p> : null}</div> : goal.metrics.length ? <div className="metric-list">{goal.metrics.map((metric, index) => { const currentMetric = rollMetricPeriod(metric); const value = currentMetric.target ? Math.min(100, (currentMetric.current / currentMetric.target) * 100) : 0; return <div key={metric.id} className="metric-row"><div><span>{metric.label}{metric.period ? ` · this ${metric.period}` : ""}</span><strong>{metric.unit === "£" && "£"}{currentMetric.current.toLocaleString()} <small>/ {metric.unit === "£" && "£"}{metric.target.toLocaleString()} {metric.unit !== "£" && metric.unit}</small></strong></div><ProgressBar value={value} color={area?.color} /><Field label={`Current value${metric.period ? ` for this ${metric.period}` : ""}`}><input key={currentMetric.periodKey ?? "all-time"} type="number" min="0" max={MAX_WORKSPACE_NUMBER} onBlur={(e) => { const next = Number(e.currentTarget.value); if (!isFiniteWorkspaceNumber(next, 0)) { e.currentTarget.value = String(currentMetric.current); setEvidenceMessage("Use a finite measurement within the supported range."); return; } updateMetric(goal.id, metric.id, next); }} defaultValue={currentMetric.current} /></Field><div className="item-actions"><button aria-label={`Move ${metric.label} up`} disabled={index === 0} onClick={() => updateGoal(goal.id, { metrics: reorder(goal.metrics, index, -1) })}><ArrowUp size={14} /></button><button aria-label={`Move ${metric.label} down`} disabled={index === goal.metrics.length - 1} onClick={() => updateGoal(goal.id, { metrics: reorder(goal.metrics, index, 1) })}><ArrowDown size={14} /></button><button aria-label={`Edit ${metric.label}`} onClick={() => openMetric(metric)}><Edit3 size={14} /></button><button className="danger" aria-label={`Delete ${metric.label}`} onClick={() => deleteMetric(metric)}><Trash2 size={14} /></button></div></div>; })}</div> : <EmptyState icon={<Target />} title="No active measurements" body={`Add a real-world measurement before using this ${goal.model} progress model.`} />}
          {goal.model !== "open" && goal.metrics.length ? <div className="metric-history-list">{goal.metrics.map((metric) => <MetricHistoryChart key={metric.id} metric={metric} entries={state.metricEntries.filter((entry) => entry.goalId === goal.id && entry.metricId === metric.id)} color={area?.color} />)}</div> : null}
        </Panel>

        <Panel>
          <div className="section-heading"><div><p className="eyebrow">Meaningful stages</p><h2>{milestoneTerm} path</h2></div><Button variant="secondary" onClick={() => openMilestone()}><Plus size={15} /> Add</Button></div>
          {goal.model === "weighted" && <div className={`weight-notice ${Math.round(totalWeight) === 100 ? "valid" : ""}`}><span>{milestoneTerm} weight</span><strong>{Math.round(totalWeight)}%</strong><small>{Math.round(totalWeight) === 100 ? "Balanced" : `Adjust ${terms.milestones.toLowerCase()} to total 100%`}</small></div>}
          <div className="milestone-list">{goal.milestones.map((milestone, index) => <div key={milestone.id} className={milestone.completed ? "milestone-item completed" : "milestone-item"}><button className="milestone-toggle" aria-label={milestone.completed ? `Reopen ${milestone.title}` : `Complete ${milestone.title}`} onClick={() => toggleMilestone(goal.id, milestone.id)}><span className="milestone-line" /><span className="milestone-check">{milestone.completed ? <Check size={16} /> : <Circle size={16} />}</span><div><small>Stage {index + 1}{goal.model === "weighted" ? ` · ${Math.round(milestone.weight)}%` : ""}</small><strong>{milestone.title}</strong><span>{milestone.completed ? `Reached ${formatDate(milestone.completedAt)}` : milestone.completedAt ? `First reached ${formatDate(milestone.completedAt)} · currently reopened` : "Not reached yet"}</span></div></button><div className="item-actions"><button aria-label={`Move ${milestone.title} up`} disabled={index === 0} onClick={() => updateGoal(goal.id, { milestones: reorder(goal.milestones, index, -1) })}><ArrowUp size={14} /></button><button aria-label={`Move ${milestone.title} down`} disabled={index === goal.milestones.length - 1} onClick={() => updateGoal(goal.id, { milestones: reorder(goal.milestones, index, 1) })}><ArrowDown size={14} /></button><button aria-label={`Edit ${milestone.title}`} onClick={() => openMilestone(milestone)}><Edit3 size={14} /></button><button className="danger" aria-label={`Delete ${milestone.title}`} onClick={() => { if (window.confirm(`Delete ${milestone.title}?`)) updateGoal(goal.id, { milestones: goal.milestones.filter((item) => item.id !== milestone.id) }); }}><Trash2 size={14} /></button></div></div>)}</div>
          {!goal.milestones.length && <EmptyState icon={<Target />} title={`No ${terms.milestones.toLowerCase()} yet`} body={`Split this ${goalTerm.toLowerCase()} into stages that would feel meaningfully different.`} />}
        </Panel>

        <Panel>
          <div className="section-heading"><div><p className="eyebrow">Actions that move it</p><h2>{questTerm} board</h2></div><Button onClick={() => { setEditingQuestId(null); setQuestOpen(true); }}><Plus size={15} /> Add {questTerm.toLowerCase()}</Button></div>
          <div className="quest-list">{goal.quests.map((quest, index) => {
            const available = isQuestAvailable(quest);
            return <div key={quest.id} className={quest.completed ? "quest-row completed" : "quest-row"}>
              <button className="quest-check" aria-label={quest.completed ? `${quest.title} completed` : available ? `Record completion for ${quest.title}` : `${quest.title} is not available yet`} onClick={() => setCompletionQuestId(quest.id)} disabled={!available || goal.status !== "active"}>{quest.completed ? <Check size={16} /> : <Circle size={17} />}</button>
              <div><strong>{quest.title}</strong><span>{quest.description || (quest.dueDate ? `Due ${formatDate(quest.dueDate)}` : "Ready when useful")}</span></div>
              <div className="quest-row-meta"><Pill>{quest.kind}</Pill>{quest.repeat !== "none" && <Pill>{quest.repeat}</Pill>}{quest.durationMinutes ? <span>{quest.durationMinutes} min</span> : null}{quest.linkedGoalIds.flatMap((linkedGoalId) => { const linkedGoal = state.goals.find((item) => item.id === linkedGoalId); return linkedGoal ? [<Link key={linkedGoal.id} href={`/goals/${linkedGoal.id}`}>Also: {linkedGoal.title}</Link>] : []; })}</div>
              <div className="item-actions"><button aria-label={`Move ${quest.title} up`} disabled={index === 0} onClick={() => updateGoal(goal.id, { quests: reorder(goal.quests, index, -1) })}><ArrowUp size={14} /></button><button aria-label={`Move ${quest.title} down`} disabled={index === goal.quests.length - 1} onClick={() => updateGoal(goal.id, { quests: reorder(goal.quests, index, 1) })}><ArrowDown size={14} /></button><button aria-label={`Edit ${quest.title}`} onClick={() => { setEditingQuestId(quest.id); setQuestOpen(true); }}><Edit3 size={14} /></button><button className="danger" aria-label={`Delete ${quest.title}`} onClick={() => { if (window.confirm(`Delete ${quest.title}? Existing completion history will remain.`)) updateGoal(goal.id, { quests: goal.quests.filter((item) => item.id !== quest.id) }); }}><Trash2 size={14} /></button></div>
            </div>;
          })}</div>
          {!goal.quests.length && <EmptyState icon={<Check />} title="No next action yet" body="Add the smallest useful action that would create genuine movement." />}
        </Panel>

        {sharedQuests.length ? <Panel>
          <div className="section-heading"><div><p className="eyebrow">Shared support</p><h2>Actions housed in other {terms.goals.toLowerCase()}</h2></div></div>
          <p className="supportive-copy">These actions also support this {goalTerm.toLowerCase()}, while editing and completion remain attached to one canonical primary {goalTerm.toLowerCase()}.</p>
          <div className="quest-list">{sharedQuests.map(({ primaryGoal, quest }) => <div key={`${primaryGoal.id}:${quest.id}`} className={quest.completed ? "quest-row completed" : "quest-row"}>
            <span className="quest-check" aria-hidden="true">{quest.completed ? <Check size={16} /> : <Circle size={17} />}</span>
            <div><strong>{quest.title}</strong><span>Primary home: <Link href={`/goals/${primaryGoal.id}`}>{primaryGoal.title}</Link></span></div>
            <div className="quest-row-meta"><Pill>{quest.kind}</Pill>{quest.repeat !== "none" && <Pill>{quest.repeat}</Pill>}{quest.durationMinutes ? <span>{quest.durationMinutes} min</span> : null}</div>
            <Link className="button button-secondary" href={`/goals/${primaryGoal.id}`}>Open primary</Link>
          </div>)}</div>
        </Panel> : null}

        <Panel>
          <div className="section-heading"><div><p className="eyebrow">Context and proof</p><h2>Notes & evidence</h2></div></div>
          <Field label="Working notes"><textarea rows={5} maxLength={WORKSPACE_TEXT_LIMITS.goalNotes} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => { if (notes !== goal.notes) updateGoal(goal.id, { notes }); }} placeholder={`What are you learning about this ${goalTerm.toLowerCase()}?`} /></Field>
          <div className="evidence-add"><input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Add an evidence link or short note" /><Button variant="secondary" disabled={!evidence.trim() || evidenceBusy || goal.evidence.length >= MAX_GOAL_EVIDENCE_ITEMS} onClick={() => { if (goal.evidence.length >= MAX_GOAL_EVIDENCE_ITEMS) { setEvidenceMessage(`A ${goalTerm.toLowerCase()} can contain at most ${MAX_GOAL_EVIDENCE_ITEMS} evidence items.`); return; } const item = goalEvidenceFromText(evidence, uid("evidence")); if (!item) { setEvidenceMessage("Use a short note or a valid HTTP or HTTPS link."); return; } updateGoal(goal.id, { evidence: [...goal.evidence, item] }); setEvidence(""); setEvidenceMessage(""); }}><Plus size={15} /> Add note</Button><Button variant="secondary" disabled={evidenceBusy || evidenceWorkspaceBlocked || goal.evidence.length >= MAX_GOAL_EVIDENCE_ITEMS} onClick={() => evidenceInput.current?.click()} title={evidenceWorkspaceBlocked ? "Finish the pending workspace or sync choice first" : goal.evidence.length >= MAX_GOAL_EVIDENCE_ITEMS ? `This ${goalTerm.toLowerCase()} already has ${MAX_GOAL_EVIDENCE_ITEMS} evidence items` : undefined}><FileText size={15} /> {evidenceBusy ? "Working…" : "Add file"}</Button><input ref={evidenceInput} hidden type="file" accept={ALLOWED_EVIDENCE_MIME_TYPES.join(",")} onChange={(event) => { void addEvidenceFile(event.target.files?.[0]); event.target.value = ""; }} /></div>
          {evidenceWorkspaceBlocked && <p className="supportive-copy">File evidence is paused until the current account workspace choice or sync conflict is resolved.</p>}
          {evidenceMessage && <p className="evidence-message" role="status" aria-live="polite">{evidenceMessage}</p>}
          <div className="evidence-list">{goal.evidence.map((item) => {
            const file = item.type === "file" ? item : null;
            const safeRemotePath = file && user ? remoteEvidencePath(file, user.id, goal.id) : undefined;
            return <div key={item.id}>
              <FileText size={15} />
              {file ? <div className="evidence-file-details"><span>{file.name}</span><small>{Math.max(1, Math.round(file.size / 1024))} KB · {safeRemotePath ? "device + private cloud" : "this device"}</small></div> : item.type === "link" ? <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a> : item.type === "note" ? <span>{item.text}</span> : null}
              {file ? <div className="evidence-actions">
                <button className="evidence-sync" aria-label={`Preview ${file.name}`} disabled={evidenceBusy || evidenceWorkspaceBlocked} onClick={() => void previewEvidenceFile(file)}><Eye size={13} /> Preview</button>
                <button className="evidence-sync" aria-label={`Download ${file.name}`} disabled={evidenceBusy || evidenceWorkspaceBlocked} onClick={() => void downloadEvidenceFile(file)}><Download size={13} /> Download</button>
                {user && !safeRemotePath && <button className="evidence-sync" disabled={evidenceBusy || !cloudWriteAllowed} onClick={() => void syncEvidenceFile(file)}>Upload private copy</button>}
                <button className="evidence-sync" aria-label={`Rename ${file.name}`} disabled={evidenceBusy || evidenceWorkspaceBlocked} onClick={() => void renameEvidenceFile(file)}>Rename</button>
                <button className="evidence-remove" aria-label={`Remove ${file.name}`} disabled={evidenceBusy || evidenceWorkspaceBlocked} onClick={() => void removeEvidence(item)}><Trash2 size={14} /></button>
              </div> : <button className="evidence-remove" aria-label="Remove evidence" disabled={evidenceBusy} onClick={() => void removeEvidence(item)}><Trash2 size={14} /></button>}
            </div>;
          })}</div>
        </Panel>
      </div>

      <aside className="goal-detail-rail">
        <Panel><div className="section-heading compact"><div><p className="eyebrow">Personal development</p><h2>Connected qualities</h2></div></div><div className="connected-stats">{goal.statIds.map((statId) => { const stat = state.stats.find((item) => item.id === statId); if (!stat) return null; return <div key={statId}><span style={{ color: stat.color, background: `${stat.color}18` }}><DynamicIcon name={stat.icon} size={17} /></span><div><strong>{stat.name}</strong><small>Connected to this {goalTerm.toLowerCase()}</small></div></div>; })}</div></Panel>
        {goal.model === "consistency" && <Panel><div className="section-heading compact"><div><p className="eyebrow">Consistency context</p><h2>Real activity</h2></div></div><div className="record-grid"><div><strong>{goalCompletions.length}</strong><span>all-time sessions</span></div><div><strong>{totalMinutes ? `${Math.round(totalMinutes / 60 * 10) / 10}h` : "—"}</strong><span>time recorded</span></div><div><strong>{recentCompletions.length}</strong><span>last 30 days</span></div><div><strong>{previousCompletions.length}</strong><span>previous 30 days</span></div></div><p className="supportive-copy">This comparison describes your recorded rhythm. A quieter month is context, not a judgement.</p></Panel>}
        <Panel><div className="section-heading compact"><div><p className="eyebrow">At a glance</p><h2>{goalTerm} record</h2></div></div><div className="record-grid"><div><strong>{completedQuests}</strong><span>actions completed</span></div><div><strong>{goal.milestones.filter((item) => item.completed).length}/{goal.milestones.length}</strong><span>{terms.milestones.toLowerCase()} reached</span></div><div><strong>{goal.checkIns.length}</strong><span>written check-ins</span></div><div><strong>{activity.length}</strong><span>recent events</span></div></div></Panel>
        <Panel><div className="section-heading compact"><div><p className="eyebrow">History</p><h2>Recent movement</h2></div></div><div className="activity-list">{activity.slice(0, visibleActivity).map((event) => { const primaryGoal = event.goalId && event.goalId !== goal.id ? state.goals.find((item) => item.id === event.goalId) : undefined; return <div key={event.id}><span className={`event-dot type-${event.type}`} /><div><strong>{event.title}</strong><small>{formatDate(event.at)}{primaryGoal ? <> · Primary home: <Link href={`/goals/${primaryGoal.id}`}>{primaryGoal.title}</Link></> : null}</small></div></div>; })}{!activity.length && <p className="muted-copy">Activity will appear as you progress this {goalTerm.toLowerCase()}.</p>}{visibleActivity < activity.length ? <button className="button button-secondary history-load-more" onClick={() => setVisibleActivity((count) => count + 12)}>Load older activity ({activity.length - visibleActivity} remaining)</button> : null}</div></Panel>
      </aside>
    </div>

    {questOpen && <QuestForm key={editingQuestId ?? "new"} goalId={goal.id} open={questOpen} quest={goal.quests.find((item) => item.id === editingQuestId)} onClose={() => { setQuestOpen(false); setEditingQuestId(null); }} />}
    {completionQuestId && goal.quests.find((item) => item.id === completionQuestId) && <QuestCompletionForm key={completionQuestId} goalId={goal.id} quest={goal.quests.find((item) => item.id === completionQuestId)!} open onClose={() => setCompletionQuestId(null)} />}
    <Modal open={Boolean(evidencePreview)} onClose={closeEvidencePreview} title={evidencePreview?.name ?? "Evidence preview"} eyebrow="Evidence file" wide>
      {evidencePreview && <div className="evidence-preview">
        <div className="evidence-preview-surface">
          {evidencePreview.mimeType.startsWith("image/") && evidencePreview.objectUrl ? <Image src={evidencePreview.objectUrl} alt={`Preview of ${evidencePreview.name}`} width={1600} height={1200} unoptimized /> : null}
          {evidencePreview.mimeType === "application/pdf" && evidencePreview.objectUrl ? <iframe src={evidencePreview.objectUrl} title={`Preview of ${evidencePreview.name}`} sandbox="" /> : null}
          {evidencePreview.mimeType === "text/plain" ? <pre tabIndex={0} aria-label={`Text preview of ${evidencePreview.name}`}>{evidencePreview.text}</pre> : null}
        </div>
        <div className="evidence-preview-footer"><span>{evidencePreview.mimeType}</span><Button variant="secondary" onClick={() => downloadBlob(evidencePreview.blob, evidencePreview.name)}><Download size={15} /> Download file</Button></div>
      </div>}
    </Modal>
    <Modal open={milestoneOpen} onClose={() => { setMilestoneOpen(false); setEditingMilestoneId(null); setMilestoneError(""); }} title={editingMilestoneId ? `Edit ${milestoneTerm.toLowerCase()}` : `Add a ${milestoneTerm.toLowerCase()}`} eyebrow="Meaningful stage"><div className="form-stack"><Field label={milestoneTerm}><input data-modal-autofocus="true" maxLength={WORKSPACE_TEXT_LIMITS.milestoneTitle} value={milestoneTitle} onChange={(e) => setMilestoneTitle(e.target.value)} placeholder="Pass the A2 assessment" /></Field>{goal.model === "weighted" && <Field label={`${goalTerm} weight`} hint={`Weighted ${terms.milestones.toLowerCase()} must total no more than 100%`}><input type="number" min="0" max="100" value={milestoneWeight} onChange={(e) => { const next = Number(e.target.value); setMilestoneWeight(isFiniteWorkspaceNumber(next, 0, 100) ? next : 0); setMilestoneError(""); }} /></Field>}{milestoneError && <p className="evidence-message" role="alert">{milestoneError}</p>}<div className="button-row end"><Button variant="ghost" onClick={() => setMilestoneOpen(false)}>Cancel</Button><Button disabled={!milestoneTitle.trim() || (goal.model === "weighted" && !isFiniteWorkspaceNumber(milestoneWeight, 0, 100))} onClick={addMilestone}><Save size={16} /> Save {milestoneTerm.toLowerCase()}</Button></div></div></Modal>
    <Modal open={metricOpen} onClose={() => { setMetricOpen(false); setEditingMetricId(null); setMetricError(""); }} title={editingMetricId ? "Edit metric" : "Add a metric"} eyebrow="Real-world measurement"><div className="form-stack"><Field label="Metric"><input data-modal-autofocus="true" maxLength={WORKSPACE_TEXT_LIMITS.metricLabel} value={metricLabel} onChange={(e) => setMetricLabel(e.target.value)} placeholder="Applications submitted" /></Field><div className="form-grid"><Field label="Target"><input type="number" min="0.0000000001" max={MAX_WORKSPACE_NUMBER} value={metricTarget} onChange={(e) => { const next = Number(e.target.value); setMetricTarget(isFiniteWorkspaceNumber(next, Number.MIN_VALUE) ? next : 0); setMetricError(""); }} /></Field><Field label="Unit"><input maxLength={WORKSPACE_TEXT_LIMITS.metricUnit} value={metricUnit} onChange={(e) => setMetricUnit(e.target.value)} placeholder="applications, £, sessions…" /></Field></div>{goal.model === "numeric" && <Field label="Relative weight" hint="Used when this goal has multiple metrics"><input type="number" min="0" max="100" value={metricWeight} onChange={(e) => { const next = Number(e.target.value); setMetricWeight(isFiniteWorkspaceNumber(next, 0, 100) ? next : 0); setMetricError(""); }} /></Field>}{goal.model === "consistency" && <Field label="Reset this count every"><select value={metricPeriod} onChange={(e) => setMetricPeriod(e.target.value as ConsistencyPeriod)}><option value="week">Week</option><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option></select></Field>}{metricError && <p className="evidence-message" role="alert">{metricError}</p>}<div className="button-row end"><Button variant="ghost" onClick={() => setMetricOpen(false)}>Cancel</Button><Button disabled={!metricLabel.trim() || !isFiniteWorkspaceNumber(metricTarget, Number.MIN_VALUE) || !isFiniteWorkspaceNumber(metricWeight, 0, 100)} onClick={saveMetric}><Save size={16} /> Save metric</Button></div></div></Modal>
    <Modal open={goalEditOpen} onClose={() => setGoalEditOpen(false)} title={`Edit ${goalTerm.toLowerCase()}`} eyebrow="Direction and connections" wide><div className="form-stack"><Field label={`${goalTerm} title`}><input data-modal-autofocus="true" maxLength={WORKSPACE_TEXT_LIMITS.goalTitle} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} /></Field><Field label="Why this matters"><textarea rows={3} maxLength={WORKSPACE_TEXT_LIMITS.goalDescription} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} /></Field><div className="form-grid thirds"><Field label={`Life ${areaTerm.toLowerCase()}`}><select value={editAreaId} onChange={(e) => setEditAreaId(e.target.value)}>{state.areas.filter((item) => (!item.archived && !item.hidden) || item.id === editAreaId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Progress model"><select value={editModel} onChange={(e) => setEditModel(e.target.value as GoalModel)}><option value="numeric">Numeric metrics</option><option value="weighted">Weighted {terms.milestones.toLowerCase()}</option><option value="consistency">Consistency period</option><option value="open">Open reflection</option></select></Field><Field label="Importance"><select value={editPriority} onChange={(e) => setEditPriority(e.target.value as Priority)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></Field></div><Field label="Target date" hint="Optional"><input type="date" value={editTargetDate} onChange={(e) => setEditTargetDate(e.target.value)} /></Field>{editModel !== goal.model && <p className="setting-note">Changing the model keeps compatible structures and permanent history. Review the new model after saving so it reflects the outcome honestly.</p>}<FieldGroup label="Connected qualities"><div className="quality-list">{state.stats.filter((item) => !item.archived || editStatIds.includes(item.id)).map((stat) => { const selected = editStatIds.includes(stat.id); return <button type="button" key={stat.id} className={selected ? "selected" : ""} aria-pressed={selected} onClick={() => setEditStatIds((current) => selected ? current.filter((id) => id !== stat.id) : [...current, stat.id])}><i style={{ background: stat.color }} /><span>{stat.name}</span>{selected && <Check size={15} aria-hidden="true" />}</button>; })}</div></FieldGroup><div className="button-row end"><Button variant="ghost" onClick={() => setGoalEditOpen(false)}>Cancel</Button><Button disabled={!editTitle.trim() || !editDescription.trim() || !editAreaId} onClick={saveGoalEdit}><Save size={16} /> Save {goalTerm.toLowerCase()}</Button></div></div></Modal>
  </div>;
}
