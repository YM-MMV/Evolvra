import { describe, expect, it, vi } from "vitest";
import {
  createProviderAuthController,
  type ProviderAuthClient,
  type ProviderAuthDependencies,
} from "@/components/use-provider-auth";
import { AUTH_BOOTSTRAP_ERROR_MESSAGE } from "@/lib/provider-auth";

type AuthCallback = Parameters<ProviderAuthClient["auth"]["onAuthStateChange"]>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function authHarness() {
  const bootstrap = deferred<Awaited<ReturnType<ProviderAuthClient["auth"]["getSession"]>>>();
  let authCallback: AuthCallback | null = null;
  const unsubscribe = vi.fn();
  const signInWithOtp = vi.fn(async () => ({ error: null as unknown }));
  const signOut = vi.fn(async () => ({ error: null as unknown }));
  const client: ProviderAuthClient = {
    auth: {
      getSession: vi.fn(() => bootstrap.promise),
      onAuthStateChange: vi.fn((callback) => {
        authCallback = callback;
        return { data: { subscription: { unsubscribe } } };
      }),
      signInWithOtp,
      signOut,
    },
  };
  const dependencies: ProviderAuthDependencies = {
    configured: true,
    getClient: () => client,
    redirectOrigin: () => "https://evolvra.example",
  };
  return {
    bootstrap,
    client,
    dependencies,
    emit(event: string, session: Parameters<AuthCallback>[1]) {
      if (!authCallback) throw new Error("Auth subscription was not registered.");
      authCallback(event, session);
    },
    signInWithOtp,
    signOut,
    unsubscribe,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("provider auth controller", () => {
  it("resolves a successful session bootstrap", async () => {
    const harness = authHarness();
    const controller = createProviderAuthController(harness.dependencies);
    const notify = vi.fn();
    controller.subscribe(notify);
    const cleanup = controller.start();

    expect(controller.getSnapshot()).toEqual({
      user: null,
      resolved: false,
      bootstrapError: null,
    });

    harness.bootstrap.resolve({
      data: { session: { user: { id: "account-a", email: "a@example.com" } } },
      error: null,
    });
    await flushPromises();

    expect(controller.getSnapshot()).toEqual({
      user: { id: "account-a", email: "a@example.com" },
      resolved: true,
      bootstrapError: null,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("opens the local fallback when bootstrap returns or throws an error", async () => {
    const returnedErrorHarness = authHarness();
    const returnedErrorController = createProviderAuthController(
      returnedErrorHarness.dependencies,
    );
    returnedErrorController.start();
    returnedErrorHarness.bootstrap.resolve({
      data: { session: null },
      error: new Error("network unavailable"),
    });
    await flushPromises();

    expect(returnedErrorController.getSnapshot()).toEqual({
      user: null,
      resolved: true,
      bootstrapError: AUTH_BOOTSTRAP_ERROR_MESSAGE,
    });

    const rejectedHarness = authHarness();
    const rejectedController = createProviderAuthController(rejectedHarness.dependencies);
    rejectedController.start();
    rejectedHarness.bootstrap.reject(new Error("client failed to load"));
    await flushPromises();

    expect(rejectedController.getSnapshot()).toEqual({
      user: null,
      resolved: true,
      bootstrapError: AUTH_BOOTSTRAP_ERROR_MESSAGE,
    });
  });

  it("never accepts a session when the live auth listener could not be installed", async () => {
    const getSession = vi.fn(async () => ({
      data: { session: { user: { id: "unobserved-account" } } },
      error: null,
    }));
    const dependencies: ProviderAuthDependencies = {
      configured: true,
      redirectOrigin: () => "https://evolvra.example",
      getClient: () => ({
        auth: {
          getSession,
          onAuthStateChange: () => {
            throw new Error("listener unavailable");
          },
          signInWithOtp: vi.fn(async () => ({ error: null })),
          signOut: vi.fn(async () => ({ error: null })),
        },
      }),
    };
    const controller = createProviderAuthController(dependencies);

    controller.start();
    await flushPromises();

    expect(getSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual({
      user: null,
      resolved: true,
      bootstrapError: AUTH_BOOTSTRAP_ERROR_MESSAGE,
    });
  });

  it("delivers auth changes and ignores a stale bootstrap response", async () => {
    const harness = authHarness();
    const controller = createProviderAuthController(harness.dependencies);
    controller.start();

    harness.emit("SIGNED_IN", { user: { id: "new-account" } });
    expect(controller.getSnapshot()).toEqual({
      user: { id: "new-account" },
      resolved: true,
      bootstrapError: null,
    });

    harness.bootstrap.resolve({
      data: { session: { user: { id: "stale-account" } } },
      error: null,
    });
    await flushPromises();

    expect(controller.getSnapshot().user?.id).toBe("new-account");

    harness.emit("SIGNED_OUT", null);
    expect(controller.getSnapshot()).toEqual({
      user: null,
      resolved: true,
      bootstrapError: null,
    });
  });

  it("notifies the provider fence before publishing every observed identity", async () => {
    const harness = authHarness();
    const events: string[] = [];
    const controller = createProviderAuthController(
      harness.dependencies,
      (accountId) => events.push(`fence:${accountId ?? "local"}`),
    );
    controller.subscribe(() => {
      events.push(`subscriber:${controller.getSnapshot().user?.id ?? "local"}`);
    });
    controller.start();

    harness.emit("SIGNED_IN", { user: { id: "account-a" } });
    expect(events).toEqual([
      "fence:account-a",
      "subscriber:account-a",
    ]);

    events.length = 0;
    await controller.signOutSession();
    expect(events).toEqual([
      "fence:local",
      "subscriber:local",
    ]);
  });

  it("unsubscribes on cleanup and ignores later auth or bootstrap delivery", async () => {
    const harness = authHarness();
    const controller = createProviderAuthController(harness.dependencies);
    const notify = vi.fn();
    controller.subscribe(notify);
    const cleanup = controller.start();

    cleanup();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);

    harness.emit("SIGNED_IN", { user: { id: "late-account" } });
    harness.bootstrap.resolve({
      data: { session: { user: { id: "late-bootstrap" } } },
      error: null,
    });
    await flushPromises();

    expect(controller.getSnapshot()).toEqual({
      user: null,
      resolved: false,
      bootstrapError: null,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("requests an OTP with the current redirect origin and surfaces OTP errors", async () => {
    const harness = authHarness();
    const controller = createProviderAuthController(harness.dependencies);

    await expect(controller.signIn("person@example.com")).resolves.toBe(
      "Check your email for a secure sign-in link.",
    );
    expect(harness.signInWithOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      options: { emailRedirectTo: "https://evolvra.example" },
    });

    const otpError = new Error("OTP delivery failed");
    harness.signInWithOtp.mockResolvedValueOnce({ error: otpError });
    await expect(controller.signIn("person@example.com")).rejects.toBe(otpError);
  });

  it("surfaces raw sign-out failures without changing observed session state", async () => {
    const harness = authHarness();
    const controller = createProviderAuthController(harness.dependencies);
    controller.start();
    harness.emit("SIGNED_IN", { user: { id: "account-a" } });

    const signOutError = new Error("sign-out failed");
    harness.signOut.mockResolvedValueOnce({ error: signOutError });
    await expect(controller.signOutSession()).rejects.toBe(signOutError);

    expect(controller.getSnapshot().user?.id).toBe("account-a");
    expect(harness.signOut).toHaveBeenCalledTimes(1);
  });

  it("clears the observed user after successful sign-out", async () => {
    const harness = authHarness();
    const controller = createProviderAuthController(harness.dependencies);
    controller.start();
    harness.emit("SIGNED_IN", { user: { id: "account-a" } });

    await controller.signOutSession();

    expect(controller.getSnapshot()).toEqual({
      user: null,
      resolved: true,
      bootstrapError: null,
    });
  });

  it("forgets only the exact account after terminal erasure", () => {
    const harness = authHarness();
    const controller = createProviderAuthController(harness.dependencies);
    controller.start();
    harness.emit("SIGNED_IN", { user: { id: "account-a" } });

    controller.forgetObservedAccount("account-b");
    expect(controller.getSnapshot().user?.id).toBe("account-a");

    controller.forgetObservedAccount("account-a");
    expect(controller.getSnapshot().user).toBeNull();
  });
});
