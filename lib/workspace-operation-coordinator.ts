import {
  compareWorkspaceScopeKeys,
  type WorkspaceScopeKey,
} from "@/lib/workspace-scope";

export type WorkspaceOperation<T> = () => T | PromiseLike<T>;
export type WorkspaceOperationStartGuard = () => boolean;

export interface WorkspaceOperationCoordinator {
  run<T>(
    scope: WorkspaceScopeKey,
    operation: WorkspaceOperation<T>,
    canStart?: WorkspaceOperationStartGuard,
  ): Promise<T>;
  retire(scope: WorkspaceScopeKey): Promise<void>;
  waitForIdle(scope: WorkspaceScopeKey): Promise<void>;
  isActive(scope: WorkspaceScopeKey): boolean;
}

export class WorkspaceOperationStartRejectedError extends Error {
  readonly scope: WorkspaceScopeKey;

  constructor(scope: WorkspaceScopeKey) {
    super(`Workspace operation cannot start in scope ${scope}.`);
    this.name = "WorkspaceOperationStartRejectedError";
    this.scope = scope;
  }
}

type ScopeActivity = {
  activeCount: number;
  idleWaiters: Set<() => void>;
};

/**
 * Coordinates async work that belongs to a mounted workspace generation.
 * Each coordinator is intentionally independent so a provider can keep one
 * stable instance while deciding which workspace scopes are allowed to start.
 */
export function createWorkspaceOperationCoordinator(): WorkspaceOperationCoordinator {
  const activityByScope = new Map<WorkspaceScopeKey, ScopeActivity>();
  const scopeTails = new Map<WorkspaceScopeKey, Promise<void>>();
  // Workspace scope keys are monotonic generations. A high-water mark rejects
  // every stale generation without retaining one Set entry per reset.
  let retiredThrough: WorkspaceScopeKey | null = null;

  function assertCanStart(
    scope: WorkspaceScopeKey,
    canStart?: WorkspaceOperationStartGuard,
  ): void {
    if (
      (retiredThrough !== null && compareWorkspaceScopeKeys(scope, retiredThrough) <= 0)
      || (canStart && !canStart())
    ) {
      throw new WorkspaceOperationStartRejectedError(scope);
    }
  }

  function markActive(scope: WorkspaceScopeKey): void {
    const activity = activityByScope.get(scope);
    if (activity) {
      activity.activeCount += 1;
      return;
    }
    activityByScope.set(scope, { activeCount: 1, idleWaiters: new Set() });
  }

  function markFinished(scope: WorkspaceScopeKey): void {
    const activity = activityByScope.get(scope);
    if (!activity) return;

    activity.activeCount -= 1;
    if (activity.activeCount > 0) return;

    activityByScope.delete(scope);
    for (const resolve of activity.idleWaiters) resolve();
  }

  return {
    async run<T>(
      scope: WorkspaceScopeKey,
      operation: WorkspaceOperation<T>,
      canStart?: WorkspaceOperationStartGuard,
    ): Promise<T> {
      assertCanStart(scope, canStart);

      markActive(scope);
      const previous = scopeTails.get(scope) ?? Promise.resolve();
      let releaseTurn!: () => void;
      const turn = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      const tail = previous.then(() => turn);
      scopeTails.set(scope, tail);
      await previous;
      try {
        // The scope may have been retired, or its account guard may have
        // changed, while this operation waited for an earlier turn.
        assertCanStart(scope, canStart);
        return await operation();
      } finally {
        releaseTurn();
        markFinished(scope);
        if (!activityByScope.has(scope) && scopeTails.get(scope) === tail) {
          scopeTails.delete(scope);
        }
      }
    },

    async retire(scope: WorkspaceScopeKey): Promise<void> {
      // Retirement is synchronous with respect to admission: every run call
      // after this line is rejected, while already admitted work remains
      // tracked until its operation and compensation have both finished.
      if (
        retiredThrough === null
        || compareWorkspaceScopeKeys(scope, retiredThrough) > 0
      ) {
        retiredThrough = scope;
      }
      const retirementBoundary = retiredThrough;
      const activeScopes = [...activityByScope.keys()].filter(
        (activeScope) => compareWorkspaceScopeKeys(activeScope, retirementBoundary) <= 0,
      );
      await Promise.all(activeScopes.map((activeScope) => this.waitForIdle(activeScope)));
    },

    waitForIdle(scope: WorkspaceScopeKey): Promise<void> {
      const activity = activityByScope.get(scope);
      if (!activity) return Promise.resolve();

      return new Promise((resolve) => {
        activity.idleWaiters.add(resolve);
      });
    },

    isActive(scope: WorkspaceScopeKey): boolean {
      return (activityByScope.get(scope)?.activeCount ?? 0) > 0;
    },
  };
}
