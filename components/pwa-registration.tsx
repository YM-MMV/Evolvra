"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

export type PwaRegistrationStatus =
  | { state: "idle"; message: string }
  | { state: "registering"; message: string }
  | { state: "ready"; message: string }
  | { state: "offline"; message: string }
  | { state: "partial"; message: string }
  | { state: "update-available"; message: string }
  | { state: "unsupported"; message: string }
  | { state: "error"; message: string };

export interface PwaRegistrationProps {
  goalIds?: readonly string[];
  goalLabel?: string;
  goalSingularLabel?: string;
  onStatusChange?: (status: PwaRegistrationStatus) => void;
  showStatus?: boolean;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface WorkspaceGoalRoutesSyncedMessage {
  type: "WORKSPACE_GOAL_ROUTES_SYNCED";
  accepted: boolean;
  reason?: string;
  clientRequested: number;
  requested: number;
  cached: number;
  failed: number;
}

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const MAX_WORKSPACE_GOAL_ROUTES = 2_000;
const OFFLINE_SHELL_ROUTES = new Set([
  "/",
  "/goals",
  "/quests",
  "/stats",
  "/reviews",
  "/timeline",
  "/settings",
]);

function isOfflineDocumentRoute(pathname: string) {
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return OFFLINE_SHELL_ROUTES.has(normalized)
    || /^\/goals\/[^/]+$/.test(normalized);
}

function offlineGoalRoutes(goalIds: readonly string[]) {
  const routes = new Set<string>();
  for (const goalId of goalIds) {
    if (!goalId.length || routes.size >= MAX_WORKSPACE_GOAL_ROUTES) continue;
    try {
      routes.add(`/goals/${encodeURIComponent(goalId)}`);
    } catch {
      // An invalid Unicode identifier cannot form a safe URL and remains
      // online-only rather than breaking registration for every other goal.
    }
  }
  return [...routes].sort();
}

export function PwaRegistration({
  goalIds = [],
  goalLabel = "goals",
  goalSingularLabel = "goal",
  onStatusChange,
  showStatus = true,
}: PwaRegistrationProps) {
  const currentGoalLabel = goalLabel.trim() || "goals";
  const currentGoalSingularLabel = goalSingularLabel.trim() || "goal";
  const [status, setStatus] = useState<PwaRegistrationStatus>({ state: "idle", message: "" });
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(false);
  const callbackRef = useRef(onStatusChange);
  const goalLabelRef = useRef(currentGoalLabel);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reloadForUpdateRef = useRef(false);
  const routeSyncAttemptRef = useRef(0);
  const routeReadinessRef = useRef<"idle" | "preparing" | "ready" | "partial">("idle");
  const routeMessageRef = useRef("");
  const syncRoutesRef = useRef<() => Promise<void>>(async () => undefined);

  const publish = useCallback((nextStatus: PwaRegistrationStatus) => {
    setStatus(nextStatus);
    callbackRef.current?.(nextStatus);
  }, []);

  const publishRouteStatus = useCallback((nextStatus: PwaRegistrationStatus) => {
    if (registrationRef.current?.waiting && navigator.serviceWorker.controller) {
      publish({ state: "update-available", message: "A new Evolvra version is ready." });
      return;
    }
    publish(nextStatus);
  }, [publish]);

  useEffect(() => {
    callbackRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    goalLabelRef.current = currentGoalLabel;
  }, [currentGoalLabel]);

  useEffect(() => {
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setInstallDismissed(false);
    };
    const clearInstallPrompt = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", clearInstallPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", clearInstallPrompt);
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    const useCachedDocumentNavigation = (event: MouseEvent) => {
      if (
        navigator.onLine
        || event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
        || !(event.target instanceof Element)
      ) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (
        !anchor
        || anchor.hasAttribute("download")
        || (anchor.target && anchor.target !== "_self")
      ) return;
      const url = new URL(anchor.href, window.location.href);
      if (
        url.origin !== window.location.origin
        || url.search
        || url.hash
        || !isOfflineDocumentRoute(url.pathname)
      ) return;
      // Next client transitions request an RSC payload that is not a safe HTML
      // substitute. A real document navigation lets the service worker return
      // the already-validated shell/goal document instead.
      event.preventDefault();
      event.stopPropagation();
      window.location.assign(url.href);
    };
    document.addEventListener("click", useCachedDocumentNavigation, true);
    return () => document.removeEventListener(
      "click",
      useCachedDocumentNavigation,
      true,
    );
  }, []);

  const goalRouteSignature = offlineGoalRoutes(goalIds).join("\n");

  const syncWorkspaceGoalRoutes = useCallback(async () => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const attempt = routeSyncAttemptRef.current + 1;
    routeSyncAttemptRef.current = attempt;
    routeReadinessRef.current = "preparing";
    routeMessageRef.current = "";
    publishRouteStatus(navigator.onLine
      ? { state: "registering", message: `Preparing current ${currentGoalLabel} for offline use…` }
      : { state: "offline", message: `You are offline. Core workspace pages remain available; current-${currentGoalLabel} coverage is still being verified.` });

    try {
      const registration = registrationRef.current ?? await navigator.serviceWorker.ready;
      registrationRef.current ??= registration;
      if (attempt !== routeSyncAttemptRef.current) return;
      const worker = navigator.serviceWorker.controller ?? registration.active;
      if (!worker) throw new Error("No active service worker is available.");

      const result = await new Promise<WorkspaceGoalRoutesSyncedMessage>((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = window.setTimeout(() => {
          channel.port1.close();
          channel.port2.close();
          reject(new Error("Offline route preparation timed out."));
        }, 60_000);
        channel.port1.onmessage = (event: MessageEvent<WorkspaceGoalRoutesSyncedMessage>) => {
          if (event.data?.type !== "WORKSPACE_GOAL_ROUTES_SYNCED") return;
          window.clearTimeout(timeout);
          channel.port1.close();
          channel.port2.close();
          resolve(event.data);
        };
        worker.postMessage({
          type: "SYNC_WORKSPACE_GOAL_ROUTES",
          paths: goalRouteSignature ? goalRouteSignature.split("\n") : [],
        }, [channel.port2]);
      });
      if (attempt !== routeSyncAttemptRef.current) return;

      if (result.accepted && result.failed === 0 && result.cached === result.requested) {
        routeReadinessRef.current = "ready";
        const readyMessage = result.clientRequested
          ? `Offline support is ready for ${result.clientRequested.toLocaleString("en-GB")} current ${result.clientRequested === 1 ? currentGoalSingularLabel : currentGoalLabel}.`
          : "Offline support is ready for core workspace pages.";
        routeMessageRef.current = readyMessage;
        publishRouteStatus(navigator.onLine
          ? { state: "ready", message: readyMessage }
          : { state: "offline", message: readyMessage });
        return;
      }

      routeReadinessRef.current = "partial";
      const reason = result.reason === "client-limit" || result.reason === "union-limit"
        ? "Too many simultaneous workspace routes are open in this browser."
        : `Some current ${currentGoalLabel} could not be prepared.`;
      const message = `${reason} Core pages remain available; reconnect and Evolvra will retry.`;
      routeMessageRef.current = message;
      publishRouteStatus({ state: "partial", message });
    } catch {
      if (attempt !== routeSyncAttemptRef.current) return;
      routeReadinessRef.current = "partial";
      const message = `Current ${currentGoalLabel} could not all be prepared for offline use. Core pages remain available; reconnect and Evolvra will retry.`;
      routeMessageRef.current = message;
      publishRouteStatus({ state: "partial", message });
    }
  }, [currentGoalLabel, currentGoalSingularLabel, goalRouteSignature, publishRouteStatus]);

  useEffect(() => {
    syncRoutesRef.current = syncWorkspaceGoalRoutes;
  }, [syncWorkspaceGoalRoutes]);

  useEffect(() => {
    void syncWorkspaceGoalRoutes();
    return () => { routeSyncAttemptRef.current += 1; };
  }, [syncWorkspaceGoalRoutes]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;

    let disposed = false;
    const workerCleanups: Array<() => void> = [];
    const watchedWorkers = new WeakSet<ServiceWorker>();

    const publishWhileMounted = (nextStatus: PwaRegistrationStatus) => {
      if (!disposed) publish(nextStatus);
    };

    const publishCurrentRouteState = () => {
      if (registrationRef.current?.waiting && navigator.serviceWorker.controller) {
        publishWhileMounted({ state: "update-available", message: "A new Evolvra version is ready." });
        return;
      }
      if (routeReadinessRef.current === "ready") {
        publishWhileMounted(navigator.onLine
          ? { state: "ready", message: routeMessageRef.current || "Offline support is ready." }
          : { state: "offline", message: routeMessageRef.current || "Offline support is ready for this workspace." });
        return;
      }
      if (routeReadinessRef.current === "partial") {
        publishWhileMounted({
          state: "partial",
          message: routeMessageRef.current || `Some current ${goalLabelRef.current} are not available offline yet. Core workspace pages remain available.`,
        });
        return;
      }
      publishWhileMounted(navigator.onLine
        ? { state: "registering", message: "Preparing offline support…" }
        : { state: "offline", message: "You are offline. Core workspace pages remain available while offline coverage is verified." });
    };

    const watchWorker = (worker: ServiceWorker | null) => {
      if (!worker || watchedWorkers.has(worker)) return;
      watchedWorkers.add(worker);
      const onStateChange = () => {
        if (worker.state !== "installed") return;
        if (navigator.serviceWorker.controller) {
          publishWhileMounted({ state: "update-available", message: "A new Evolvra version is ready." });
        } else {
          publishCurrentRouteState();
        }
      };
      worker.addEventListener("statechange", onStateChange);
      workerCleanups.push(() => worker.removeEventListener("statechange", onStateChange));
    };

    const onOnline = () => {
      if (routeReadinessRef.current === "partial" || routeReadinessRef.current === "idle") {
        void syncRoutesRef.current();
      } else {
        publishCurrentRouteState();
      }
    };
    const onOffline = () => publishCurrentRouteState();
    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type !== "EVOLVRA_OFFLINE_READY") return;
      if (routeReadinessRef.current === "idle") void syncRoutesRef.current();
      else publishCurrentRouteState();
    };
    const onControllerChange = () => {
      if (reloadForUpdateRef.current) {
        reloadForUpdateRef.current = false;
        window.location.reload();
        return;
      }
      void syncRoutesRef.current();
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);

    if (!("serviceWorker" in navigator)) {
      publishWhileMounted({ state: "unsupported", message: "This browser does not support offline installation." });
      return () => {
        disposed = true;
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      };
    }

    void (async () => {
      publishWhileMounted({ state: "registering", message: "Preparing offline support…" });
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        if (disposed) return;
        registrationRef.current = registration;

        const onUpdateFound = () => watchWorker(registration.installing);
        registration.addEventListener("updatefound", onUpdateFound);
        workerCleanups.push(() => registration.removeEventListener("updatefound", onUpdateFound));
        watchWorker(registration.installing);

        if (registration.waiting && navigator.serviceWorker.controller) {
          publishWhileMounted({ state: "update-available", message: "A new Evolvra version is ready." });
        }

        void registration.update().catch(() => undefined);
      } catch {
        publishWhileMounted({ state: "error", message: "Offline support could not be prepared. Evolvra will continue online." });
      }
    })();

    return () => {
      disposed = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      workerCleanups.forEach((cleanup) => cleanup());
    };
  }, [publish]);

  const applyUpdate = () => {
    const waitingWorker = registrationRef.current?.waiting;
    if (!waitingWorker) {
      void registrationRef.current?.update();
      return;
    }
    reloadForUpdateRef.current = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  };

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  if (!showStatus) return null;

  const canOfferInstall = Boolean(installPrompt && !installDismissed);
  const visible = status.state === "offline" || status.state === "partial" || status.state === "update-available" || status.state === "error" || canOfferInstall;
  if (!visible) {
    return <span role="status" aria-live="polite" aria-atomic="true" style={visuallyHidden}>{status.message}</span>;
  }

  return (
    <div className="system-alert" role={status.state === "error" ? "alert" : "status"} aria-live="polite" aria-atomic="true">
      <span>{status.message}</span>
      {status.state === "update-available" && <button type="button" className="button button-secondary" onClick={applyUpdate}>Update now</button>}
      {canOfferInstall && status.state !== "update-available" && <><span>Install Evolvra for quicker access and offline-ready pages.</span><button type="button" className="button button-secondary" onClick={() => void install()}>Install app</button><button type="button" className="button button-ghost" onClick={() => setInstallDismissed(true)}>Not now</button></>}
    </div>
  );
}
