"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";

export type PwaRegistrationStatus =
  | { state: "idle"; message: string }
  | { state: "registering"; message: string }
  | { state: "ready"; message: string }
  | { state: "offline"; message: string }
  | { state: "update-available"; message: string }
  | { state: "unsupported"; message: string }
  | { state: "error"; message: string };

export interface PwaRegistrationProps {
  onStatusChange?: (status: PwaRegistrationStatus) => void;
  showStatus?: boolean;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
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

export function PwaRegistration({ onStatusChange, showStatus = true }: PwaRegistrationProps) {
  const pathname = usePathname();
  const [status, setStatus] = useState<PwaRegistrationStatus>({ state: "idle", message: "" });
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(false);
  const callbackRef = useRef(onStatusChange);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reloadForUpdateRef = useRef(false);

  useEffect(() => {
    callbackRef.current = onStatusChange;
  }, [onStatusChange]);

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
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    void (async () => {
      try {
        const registration = registrationRef.current ?? await navigator.serviceWorker.ready;
        if (cancelled) return;
        const worker = navigator.serviceWorker.controller ?? registration.active;
        worker?.postMessage({ type: "CACHE_VISITED_ROUTE", pathname });
      } catch {
        // Online navigation remains available if proactive offline caching fails.
      }
    })();
    return () => { cancelled = true; };
  }, [pathname]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;

    let disposed = false;
    const workerCleanups: Array<() => void> = [];
    const watchedWorkers = new WeakSet<ServiceWorker>();

    const publish = (nextStatus: PwaRegistrationStatus) => {
      if (disposed) return;
      setStatus(nextStatus);
      callbackRef.current?.(nextStatus);
    };

    const publishReady = (message = "Offline support is ready.") => {
      if (navigator.onLine) publish({ state: "ready", message });
      else publish({ state: "offline", message: "You are offline. Previously visited workspace pages remain available." });
    };

    const watchWorker = (worker: ServiceWorker | null) => {
      if (!worker || watchedWorkers.has(worker)) return;
      watchedWorkers.add(worker);
      const onStateChange = () => {
        if (worker.state !== "installed") return;
        if (navigator.serviceWorker.controller) {
          publish({ state: "update-available", message: "A new Evolvra version is ready." });
        } else {
          publishReady();
        }
      };
      worker.addEventListener("statechange", onStateChange);
      workerCleanups.push(() => worker.removeEventListener("statechange", onStateChange));
    };

    const onOnline = () => {
      if (registrationRef.current?.waiting) publish({ state: "update-available", message: "A new Evolvra version is ready." });
      else publishReady("Connection restored. Offline support remains ready.");
    };
    const onOffline = () => publish({ state: "offline", message: "You are offline. Previously visited workspace pages remain available." });
    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "EVOLVRA_OFFLINE_READY") publishReady();
    };
    const onControllerChange = () => {
      if (reloadForUpdateRef.current) {
        reloadForUpdateRef.current = false;
        window.location.reload();
        return;
      }
      publishReady();
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);

    if (!("serviceWorker" in navigator)) {
      publish({ state: "unsupported", message: "This browser does not support offline installation." });
      return () => {
        disposed = true;
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      };
    }

    void (async () => {
      publish({ state: "registering", message: "Preparing offline support…" });
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
          publish({ state: "update-available", message: "A new Evolvra version is ready." });
        } else if (registration.active) {
          publishReady();
        }

        void registration.update().catch(() => undefined);
      } catch {
        publish({ state: "error", message: "Offline support could not be prepared. Evolvra will continue online." });
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
  }, []);

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
  const visible = status.state === "offline" || status.state === "update-available" || status.state === "error" || canOfferInstall;
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
