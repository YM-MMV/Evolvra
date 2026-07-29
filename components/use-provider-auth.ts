"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  AUTH_BOOTSTRAP_ERROR_MESSAGE,
  decideAuthBootstrap,
} from "@/lib/provider-auth";
import {
  getSupabase,
  supabaseConfigured,
  type CloudUser,
} from "@/lib/supabase";

interface ProviderAuthSession {
  user: CloudUser;
}

export interface ProviderAuthClient {
  auth: {
    getSession: () => Promise<{
      data: { session: ProviderAuthSession | null };
      error: unknown;
    }>;
    onAuthStateChange: (
      callback: (event: string, session: ProviderAuthSession | null) => void,
    ) => {
      data: {
        subscription: {
          unsubscribe: () => void;
        };
      };
    };
    signInWithOtp: (input: {
      email: string;
      options: { emailRedirectTo: string };
    }) => Promise<{ error: unknown }>;
    signOut: () => Promise<{ error: unknown }>;
  };
}

export interface ProviderAuthSnapshot {
  user: CloudUser | null;
  resolved: boolean;
  bootstrapError: string | null;
}

export interface ProviderAuthDependencies {
  configured: boolean;
  getClient: () => ProviderAuthClient | null;
  redirectOrigin: () => string;
}

export interface ProviderAuthController {
  getSnapshot: () => ProviderAuthSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: () => () => void;
  signIn: (email: string) => Promise<string>;
  signOutSession: () => Promise<void>;
  forgetObservedAccount: (accountId: string) => void;
}

export type ProviderAuthBoundaryObserver = (accountId: string | null) => void;

const SIGN_IN_SUCCESS_MESSAGE = "Check your email for a secure sign-in link.";
const MISSING_CONFIGURATION_MESSAGE = "Add Supabase environment variables first.";

function browserOrigin() {
  if (typeof window === "undefined") {
    throw new Error("Sign-in is only available in a browser.");
  }
  return window.location.origin;
}

export const DEFAULT_PROVIDER_AUTH_DEPENDENCIES: ProviderAuthDependencies = {
  configured: supabaseConfigured,
  getClient: () => getSupabase() as ProviderAuthClient | null,
  redirectOrigin: browserOrigin,
};

/**
 * Owns only the raw Supabase auth lifecycle. Account switching, persistence,
 * cloud reconciliation, and sign-out workspace fencing remain provider work.
 */
export function createProviderAuthController(
  dependencies: ProviderAuthDependencies = DEFAULT_PROVIDER_AUTH_DEPENDENCIES,
  observeAuthBoundary: ProviderAuthBoundaryObserver = () => {},
): ProviderAuthController {
  let snapshot: ProviderAuthSnapshot = {
    user: null,
    resolved: !dependencies.configured,
    bootstrapError: null,
  };
  const listeners = new Set<() => void>();

  const updateSnapshot = (next: ProviderAuthSnapshot) => {
    // Close provider-side writers before React or any subscriber can observe a
    // different authenticated identity.
    observeAuthBoundary(next.user?.id ?? null);
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const requireClient = () => {
    const client = dependencies.getClient();
    if (!client) throw new Error(MISSING_CONFIGURATION_MESSAGE);
    return client;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      let active = true;
      let authEventVersion = 0;
      let unsubscribe = () => {};
      let client: ProviderAuthClient;

      try {
        client = requireClient();
      } catch {
        if (dependencies.configured) {
          updateSnapshot({
            user: null,
            resolved: true,
            bootstrapError: AUTH_BOOTSTRAP_ERROR_MESSAGE,
          });
        }
        return () => {
          active = false;
        };
      }

      const applySession = (session: ProviderAuthSession | null) => {
        if (!active) return;
        updateSnapshot({
          user: session?.user ?? null,
          resolved: true,
          bootstrapError: null,
        });
      };

      try {
        const { data } = client.auth.onAuthStateChange((_event, session) => {
          authEventVersion += 1;
          applySession(session);
        });
        unsubscribe = () => data.subscription.unsubscribe();
      } catch {
        updateSnapshot({
          user: null,
          resolved: true,
          bootstrapError: AUTH_BOOTSTRAP_ERROR_MESSAGE,
        });
        return () => {
          active = false;
          unsubscribe();
        };
      }

      const bootstrapVersion = authEventVersion;
      void client.auth.getSession()
        .then(({ data, error }) => {
          if (!active || authEventVersion !== bootstrapVersion) return;
          const decision = decideAuthBootstrap(data.session, error);
          if (decision.action === "apply-session") {
            applySession(decision.session);
            return;
          }
          updateSnapshot({
            user: null,
            resolved: decision.authResolved,
            bootstrapError: decision.message,
          });
        })
        .catch((error: unknown) => {
          if (!active || authEventVersion !== bootstrapVersion) return;
          const decision = decideAuthBootstrap<CloudUser>(null, error);
          if (decision.action !== "open-local-fallback") return;
          updateSnapshot({
            user: null,
            resolved: decision.authResolved,
            bootstrapError: decision.message,
          });
        });

      return () => {
        active = false;
        unsubscribe();
      };
    },
    async signIn(email) {
      const { error } = await requireClient().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: dependencies.redirectOrigin() },
      });
      if (error) throw error;
      return SIGN_IN_SUCCESS_MESSAGE;
    },
    async signOutSession() {
      const { error } = await requireClient().auth.signOut();
      if (error) throw error;
      if (snapshot.user) {
        updateSnapshot({
          user: null,
          resolved: true,
          bootstrapError: null,
        });
      }
    },
    forgetObservedAccount(accountId) {
      if (snapshot.user?.id !== accountId) return;
      updateSnapshot({
        user: null,
        resolved: true,
        bootstrapError: null,
      });
    },
  };
}

export interface ProviderAuthValue extends ProviderAuthSnapshot {
  signIn: (email: string) => Promise<string>;
  signOutSession: () => Promise<void>;
  forgetObservedAccount: (accountId: string) => void;
}

export function useProviderAuth(
  dependencies: ProviderAuthDependencies = DEFAULT_PROVIDER_AUTH_DEPENDENCIES,
  observeAuthBoundary?: ProviderAuthBoundaryObserver,
): ProviderAuthValue {
  const [controller] = useState(() => createProviderAuthController(
    dependencies,
    observeAuthBoundary,
  ));
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => controller.start(), [controller]);

  return {
    ...snapshot,
    signIn: controller.signIn,
    signOutSession: controller.signOutSession,
    forgetObservedAccount: controller.forgetObservedAccount,
  };
}
