"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { AppActionsContextValue } from "@/components/app-context";

/**
 * Context consumers keep the same command references across provider renders,
 * while each command delegates to the implementation from the latest commit.
 */
export function useStableAppActions(
  implementation: AppActionsContextValue,
): AppActionsContextValue {
  const current = useRef(implementation);
  useLayoutEffect(() => {
    current.current = implementation;
  }, [implementation]);

  const completeOnboarding = useCallback<AppActionsContextValue["completeOnboarding"]>(
    (...args) => current.current.completeOnboarding(...args),
    [],
  );
  const addGoal = useCallback<AppActionsContextValue["addGoal"]>(
    (...args) => current.current.addGoal(...args),
    [],
  );
  const updateGoal = useCallback<AppActionsContextValue["updateGoal"]>(
    (...args) => current.current.updateGoal(...args),
    [],
  );
  const setGoalStatus = useCallback<AppActionsContextValue["setGoalStatus"]>(
    (...args) => current.current.setGoalStatus(...args),
    [],
  );
  const addQuest = useCallback<AppActionsContextValue["addQuest"]>(
    (...args) => current.current.addQuest(...args),
    [],
  );
  const completeQuest = useCallback<AppActionsContextValue["completeQuest"]>(
    (...args) => current.current.completeQuest(...args),
    [],
  );
  const toggleMilestone = useCallback<AppActionsContextValue["toggleMilestone"]>(
    (...args) => current.current.toggleMilestone(...args),
    [],
  );
  const updateMetric = useCallback<AppActionsContextValue["updateMetric"]>(
    (...args) => current.current.updateMetric(...args),
    [],
  );
  const addCheckIn = useCallback<AppActionsContextValue["addCheckIn"]>(
    (...args) => current.current.addCheckIn(...args),
    [],
  );
  const addReview = useCallback<AppActionsContextValue["addReview"]>(
    (...args) => current.current.addReview(...args),
    [],
  );
  const upsertArea = useCallback<AppActionsContextValue["upsertArea"]>(
    (...args) => current.current.upsertArea(...args),
    [],
  );
  const reorderAreas = useCallback<AppActionsContextValue["reorderAreas"]>(
    (...args) => current.current.reorderAreas(...args),
    [],
  );
  const removeArea = useCallback<AppActionsContextValue["removeArea"]>(
    (...args) => current.current.removeArea(...args),
    [],
  );
  const upsertStat = useCallback<AppActionsContextValue["upsertStat"]>(
    (...args) => current.current.upsertStat(...args),
    [],
  );
  const reorderStats = useCallback<AppActionsContextValue["reorderStats"]>(
    (...args) => current.current.reorderStats(...args),
    [],
  );
  const removeStat = useCallback<AppActionsContextValue["removeStat"]>(
    (...args) => current.current.removeStat(...args),
    [],
  );
  const updateSettings = useCallback<AppActionsContextValue["updateSettings"]>(
    (...args) => current.current.updateSettings(...args),
    [],
  );
  const updateProfile = useCallback<AppActionsContextValue["updateProfile"]>(
    (...args) => current.current.updateProfile(...args),
    [],
  );
  const setGoalFileEvidence = useCallback<AppActionsContextValue["setGoalFileEvidence"]>(
    (...args) => current.current.setGoalFileEvidence(...args),
    [],
  );
  const readGoalEvidenceBlob = useCallback<AppActionsContextValue["readGoalEvidenceBlob"]>(
    (...args) => current.current.readGoalEvidenceBlob(...args),
    [],
  );
  const stageGoalEvidenceBlob = useCallback<AppActionsContextValue["stageGoalEvidenceBlob"]>(
    (...args) => current.current.stageGoalEvidenceBlob(...args),
    [],
  );
  const rollbackGoalEvidenceStage = useCallback<AppActionsContextValue["rollbackGoalEvidenceStage"]>(
    (...args) => current.current.rollbackGoalEvidenceStage(...args),
    [],
  );
  const cacheGoalEvidenceBlob = useCallback<AppActionsContextValue["cacheGoalEvidenceBlob"]>(
    (...args) => current.current.cacheGoalEvidenceBlob(...args),
    [],
  );
  const deleteGoalEvidenceBlobs = useCallback<AppActionsContextValue["deleteGoalEvidenceBlobs"]>(
    (...args) => current.current.deleteGoalEvidenceBlobs(...args),
    [],
  );
  const restoreGoalEvidenceBlobs = useCallback<AppActionsContextValue["restoreGoalEvidenceBlobs"]>(
    (...args) => current.current.restoreGoalEvidenceBlobs(...args),
    [],
  );
  const stageGoalEvidenceCleanup = useCallback<AppActionsContextValue["stageGoalEvidenceCleanup"]>(
    (...args) => current.current.stageGoalEvidenceCleanup(...args),
    [],
  );
  const cancelGoalEvidenceCleanup = useCallback<AppActionsContextValue["cancelGoalEvidenceCleanup"]>(
    (...args) => current.current.cancelGoalEvidenceCleanup(...args),
    [],
  );
  const runWorkspaceFileOperation = useCallback<AppActionsContextValue["runWorkspaceFileOperation"]>(
    (...args) => current.current.runWorkspaceFileOperation(...args),
    [],
  );
  const reportPersistenceError = useCallback<AppActionsContextValue["reportPersistenceError"]>(
    (...args) => current.current.reportPersistenceError(...args),
    [],
  );
  const deleteGoal = useCallback<AppActionsContextValue["deleteGoal"]>(
    (...args) => current.current.deleteGoal(...args),
    [],
  );
  const importState = useCallback<AppActionsContextValue["importState"]>(
    (...args) => current.current.importState(...args),
    [],
  );
  const exportPortableWorkspaceArchive = useCallback<AppActionsContextValue["exportPortableWorkspaceArchive"]>(
    (...args) => current.current.exportPortableWorkspaceArchive(...args),
    [],
  );
  const inspectPortableWorkspaceArchive = useCallback<AppActionsContextValue["inspectPortableWorkspaceArchive"]>(
    (...args) => current.current.inspectPortableWorkspaceArchive(...args),
    [],
  );
  const discardPortableWorkspaceArchiveImport = useCallback<AppActionsContextValue["discardPortableWorkspaceArchiveImport"]>(
    (...args) => current.current.discardPortableWorkspaceArchiveImport(...args),
    [],
  );
  const applyPortableWorkspaceArchive = useCallback<AppActionsContextValue["applyPortableWorkspaceArchive"]>(
    (...args) => current.current.applyPortableWorkspaceArchive(...args),
    [],
  );
  const resetWorkspace = useCallback<AppActionsContextValue["resetWorkspace"]>(
    (...args) => current.current.resetWorkspace(...args),
    [],
  );
  const discardQuarantinedWorkspace = useCallback<AppActionsContextValue["discardQuarantinedWorkspace"]>(
    (...args) => current.current.discardQuarantinedWorkspace(...args),
    [],
  );
  const undo = useCallback<AppActionsContextValue["undo"]>(
    (...args) => current.current.undo(...args),
    [],
  );
  const retrySync = useCallback<AppActionsContextValue["retrySync"]>(
    (...args) => current.current.retrySync(...args),
    [],
  );
  const resolveAccountHandoff = useCallback<AppActionsContextValue["resolveAccountHandoff"]>(
    (...args) => current.current.resolveAccountHandoff(...args),
    [],
  );
  const resolveSyncConflict = useCallback<AppActionsContextValue["resolveSyncConflict"]>(
    (...args) => current.current.resolveSyncConflict(...args),
    [],
  );
  const signIn = useCallback<AppActionsContextValue["signIn"]>(
    (...args) => current.current.signIn(...args),
    [],
  );
  const signOut = useCallback<AppActionsContextValue["signOut"]>(
    (...args) => current.current.signOut(...args),
    [],
  );
  const beginActiveAccountErasure = useCallback<AppActionsContextValue["beginActiveAccountErasure"]>(
    (...args) => current.current.beginActiveAccountErasure(...args),
    [],
  );
  const cancelActiveAccountErasure = useCallback<AppActionsContextValue["cancelActiveAccountErasure"]>(
    (...args) => current.current.cancelActiveAccountErasure(...args),
    [],
  );
  const adoptActiveAccountErasure = useCallback<AppActionsContextValue["adoptActiveAccountErasure"]>(
    (...args) => current.current.adoptActiveAccountErasure(...args),
    [],
  );
  const finishActiveAccountErasure = useCallback<AppActionsContextValue["finishActiveAccountErasure"]>(
    (...args) => current.current.finishActiveAccountErasure(...args),
    [],
  );

  return useMemo(() => ({
    completeOnboarding,
    addGoal,
    updateGoal,
    setGoalStatus,
    addQuest,
    completeQuest,
    toggleMilestone,
    updateMetric,
    addCheckIn,
    addReview,
    upsertArea,
    reorderAreas,
    removeArea,
    upsertStat,
    reorderStats,
    removeStat,
    updateSettings,
    updateProfile,
    setGoalFileEvidence,
    readGoalEvidenceBlob,
    stageGoalEvidenceBlob,
    rollbackGoalEvidenceStage,
    cacheGoalEvidenceBlob,
    deleteGoalEvidenceBlobs,
    restoreGoalEvidenceBlobs,
    stageGoalEvidenceCleanup,
    cancelGoalEvidenceCleanup,
    runWorkspaceFileOperation,
    reportPersistenceError,
    deleteGoal,
    importState,
    exportPortableWorkspaceArchive,
    inspectPortableWorkspaceArchive,
    discardPortableWorkspaceArchiveImport,
    applyPortableWorkspaceArchive,
    resetWorkspace,
    discardQuarantinedWorkspace,
    undo,
    retrySync,
    resolveAccountHandoff,
    resolveSyncConflict,
    signIn,
    signOut,
    beginActiveAccountErasure,
    cancelActiveAccountErasure,
    adoptActiveAccountErasure,
    finishActiveAccountErasure,
  }), [
    addCheckIn,
    addGoal,
    addQuest,
    addReview,
    adoptActiveAccountErasure,
    beginActiveAccountErasure,
    cancelActiveAccountErasure,
    completeOnboarding,
    completeQuest,
    deleteGoal,
    discardQuarantinedWorkspace,
    finishActiveAccountErasure,
    applyPortableWorkspaceArchive,
    importState,
    exportPortableWorkspaceArchive,
    discardPortableWorkspaceArchiveImport,
    inspectPortableWorkspaceArchive,
    removeArea,
    removeStat,
    reorderAreas,
    reorderStats,
    reportPersistenceError,
    resetWorkspace,
    resolveAccountHandoff,
    resolveSyncConflict,
    retrySync,
    runWorkspaceFileOperation,
    setGoalFileEvidence,
    readGoalEvidenceBlob,
    stageGoalEvidenceBlob,
    rollbackGoalEvidenceStage,
    cacheGoalEvidenceBlob,
    deleteGoalEvidenceBlobs,
    restoreGoalEvidenceBlobs,
    stageGoalEvidenceCleanup,
    cancelGoalEvidenceCleanup,
    setGoalStatus,
    signIn,
    signOut,
    toggleMilestone,
    undo,
    updateGoal,
    updateMetric,
    updateProfile,
    updateSettings,
    upsertArea,
    upsertStat,
  ]);
}
