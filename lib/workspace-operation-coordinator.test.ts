import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceOperationCoordinator,
  WorkspaceOperationStartRejectedError,
} from "@/lib/workspace-operation-coordinator";
import { workspaceScopeKeyFromDecimal } from "@/lib/workspace-scope";

const scope = (value: number | string) => workspaceScopeKeyFromDecimal(String(value));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("workspace operation coordinator", () => {
  it("serializes side effects within one workspace scope", async () => {
    const coordinator = createWorkspaceOperationCoordinator();
    const first = deferred<void>();
    const order: string[] = [];

    const firstRun = coordinator.run(scope(3), async () => {
      order.push("first-start");
      await first.promise;
      order.push("first-end");
    });
    const secondRun = coordinator.run(scope(3), () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    first.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("tracks every operation in a scope until all of them finish", async () => {
    const coordinator = createWorkspaceOperationCoordinator();
    const first = deferred<string>();
    const second = deferred<string>();

    const firstRun = coordinator.run(scope(4), () => first.promise);
    const secondRun = coordinator.run(scope(4), () => second.promise);
    let becameIdle = false;
    const idle = coordinator.waitForIdle(scope(4)).then(() => {
      becameIdle = true;
    });

    expect(coordinator.isActive(scope(4))).toBe(true);
    first.resolve("first");
    await expect(firstRun).resolves.toBe("first");
    await Promise.resolve();
    expect(coordinator.isActive(scope(4))).toBe(true);
    expect(becameIdle).toBe(false);

    second.resolve("second");
    await expect(secondRun).resolves.toBe("second");
    await idle;
    expect(coordinator.isActive(scope(4))).toBe(false);
    expect(becameIdle).toBe(true);
  });

  it("settles idle waiters after rejected and synchronously throwing operations", async () => {
    const coordinator = createWorkspaceOperationCoordinator();
    const failure = new Error("operation failed");
    const pending = deferred<void>();

    const rejectedRun = coordinator.run(scope(8), () => pending.promise);
    const idleAfterRejection = coordinator.waitForIdle(scope(8));
    pending.reject(failure);

    await expect(rejectedRun).rejects.toBe(failure);
    await expect(idleAfterRejection).resolves.toBeUndefined();
    expect(coordinator.isActive(scope(8))).toBe(false);

    const thrownRun = coordinator.run(scope(8), () => {
      throw failure;
    });
    const idleAfterThrow = coordinator.waitForIdle(scope(8));
    await expect(thrownRun).rejects.toBe(failure);
    await expect(idleAfterThrow).resolves.toBeUndefined();
    expect(coordinator.isActive(scope(8))).toBe(false);
  });

  it("isolates activity and idle waits between workspace scopes", async () => {
    const coordinator = createWorkspaceOperationCoordinator();
    const scopeOne = deferred<void>();
    const scopeTwo = deferred<void>();

    const runOne = coordinator.run(scope(1), () => scopeOne.promise);
    const runTwo = coordinator.run(scope(2), () => scopeTwo.promise);
    let scopeTwoIdle = false;
    const waitForScopeTwo = coordinator.waitForIdle(scope(2)).then(() => {
      scopeTwoIdle = true;
    });

    scopeOne.resolve();
    await runOne;
    await coordinator.waitForIdle(scope(1));
    expect(coordinator.isActive(scope(1))).toBe(false);
    expect(coordinator.isActive(scope(2))).toBe(true);
    expect(scopeTwoIdle).toBe(false);

    scopeTwo.resolve();
    await runTwo;
    await waitForScopeTwo;
    expect(scopeTwoIdle).toBe(true);
  });

  it("rejects a guarded start without tracking or invoking the operation", async () => {
    const coordinator = createWorkspaceOperationCoordinator();
    const operation = vi.fn();

    await expect(coordinator.run(scope(12), operation, () => false)).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceOperationStartRejectedError>>({
        name: "WorkspaceOperationStartRejectedError",
        scope: scope(12),
      }),
    );
    expect(operation).not.toHaveBeenCalled();
    expect(coordinator.isActive(scope(12))).toBe(false);
    await expect(coordinator.waitForIdle(scope(12))).resolves.toBeUndefined();
  });

  it("retires admission synchronously and waits for admitted work to finish", async () => {
    const coordinator = createWorkspaceOperationCoordinator();
    const active = deferred<void>();
    const started = deferred<void>();
    const activeRun = coordinator.run(scope(30), async () => {
      started.resolve();
      await active.promise;
    });
    let retired = false;
    await started.promise;

    const retirement = coordinator.retire(scope(30)).then(() => {
      retired = true;
    });

    await expect(coordinator.run(scope(30), vi.fn())).rejects.toMatchObject({
      name: "WorkspaceOperationStartRejectedError",
      scope: "30",
    });
    expect(retired).toBe(false);
    active.resolve();
    await activeRun;
    await retirement;
    expect(retired).toBe(true);
    await expect(coordinator.run(scope(31), async () => "new scope")).resolves.toBe("new scope");
  });

  it("retires through and drains admitted work from every older scope", async () => {
    const coordinator = createWorkspaceOperationCoordinator();
    const olderWork = deferred<void>();
    const olderStarted = deferred<void>();
    const olderRun = coordinator.run(scope(0), async () => {
      olderStarted.resolve();
      await olderWork.promise;
    });
    await olderStarted.promise;

    let retired = false;
    const retirement = coordinator.retire(scope(1)).then(() => {
      retired = true;
    });
    await Promise.resolve();

    expect(retired).toBe(false);
    await expect(coordinator.run(scope(0), vi.fn())).rejects.toMatchObject({
      name: "WorkspaceOperationStartRejectedError",
      scope: "0",
    });
    await expect(coordinator.run(scope(1), vi.fn())).rejects.toMatchObject({
      name: "WorkspaceOperationStartRejectedError",
      scope: "1",
    });
    olderWork.resolve();
    await olderRun;
    await retirement;
    expect(retired).toBe(true);
  });

  it("rechecks a queued account guard before its first side effect", async () => {
    const coordinator = createWorkspaceOperationCoordinator();
    const active = deferred<void>();
    let accountIsCurrent = true;
    const queuedOperation = vi.fn();
    const activeRun = coordinator.run(scope(31), () => active.promise);
    const queuedRun = coordinator.run(scope(31), queuedOperation, () => accountIsCurrent);

    accountIsCurrent = false;
    active.resolve();

    await activeRun;
    await expect(queuedRun).rejects.toMatchObject({
      name: "WorkspaceOperationStartRejectedError",
      scope: "31",
    });
    expect(queuedOperation).not.toHaveBeenCalled();
    await expect(coordinator.waitForIdle(scope(31))).resolves.toBeUndefined();
  });

  it("propagates a throwing start guard without tracking or invoking", async () => {
    const coordinator = createWorkspaceOperationCoordinator();
    const operation = vi.fn();
    const guardFailure = new Error("stale workspace");

    await expect(coordinator.run(scope(21), operation, () => {
      throw guardFailure;
    })).rejects.toBe(guardFailure);
    expect(operation).not.toHaveBeenCalled();
    expect(coordinator.isActive(scope(21))).toBe(false);
  });

  it("resolves idle immediately for a scope with no active work", async () => {
    const coordinator = createWorkspaceOperationCoordinator();

    expect(coordinator.isActive(scope(99))).toBe(false);
    await expect(coordinator.waitForIdle(scope(99))).resolves.toBeUndefined();
  });
});
