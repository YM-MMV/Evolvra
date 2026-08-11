"use client";

import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  createOverlayLease,
  restoreOverlayFocus,
} from "@/components/overlay-effects";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export type BlockingRecoveryLayer = "bootstrap" | "quarantine" | "terminal";

const BLOCKING_RECOVERY_LAYERS: Record<
  BlockingRecoveryLayer,
  { readonly priority: number; readonly zIndex: number }
> = {
  bootstrap: { priority: 1, zIndex: 1_000 },
  quarantine: { priority: 2, zIndex: 1_100 },
  terminal: { priority: 3, zIndex: 1_200 },
};

interface BlockingScreenRegistration {
  readonly element: HTMLElement;
  readonly priority: number;
  readonly activate: () => () => void;
  deactivate: (() => void) | null;
}

const blockingScreenStack: BlockingScreenRegistration[] = [];

function visibleFocusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hidden
      && element.getAttribute("aria-hidden") !== "true"
      && !element.closest("[inert]")
      && element.getClientRects().length > 0);
}

function reconcileBlockingScreens() {
  const topmost = blockingScreenStack.reduce<BlockingScreenRegistration | null>(
    (current, registration) => {
      if (!registration.element.isConnected) return current;
      if (!current || registration.priority >= current.priority) {
        return registration;
      }
      return current;
    },
    null,
  );

  for (const registration of blockingScreenStack) {
    if (registration === topmost && !registration.deactivate) {
      registration.deactivate = registration.activate();
    } else if (registration !== topmost && registration.deactivate) {
      registration.deactivate();
      registration.deactivate = null;
    }
  }
}

function registerBlockingScreen(
  element: HTMLElement,
  priority: number,
  activate: () => () => void,
) {
  const registration: BlockingScreenRegistration = {
    element,
    priority,
    activate,
    deactivate: null,
  };
  blockingScreenStack.push(registration);
  reconcileBlockingScreens();

  return () => {
    const index = blockingScreenStack.indexOf(registration);
    if (index >= 0) blockingScreenStack.splice(index, 1);
    registration.deactivate?.();
    registration.deactivate = null;
    reconcileBlockingScreens();
  };
}

function backgroundBranches(dialog: HTMLElement) {
  const branches = new Set<HTMLElement>();
  let activeBranch: HTMLElement = dialog;
  let parent = activeBranch.parentElement;

  while (parent) {
    for (const sibling of parent.children) {
      if (sibling !== activeBranch && sibling instanceof HTMLElement) {
        branches.add(sibling);
      }
    }
    if (parent === document.body) break;
    activeBranch = parent;
    parent = parent.parentElement;
  }

  return branches;
}

function setBlockingBackground(
  dialog: HTMLElement,
  overlay: ReturnType<typeof createOverlayLease>,
) {
  for (const element of backgroundBranches(dialog)) {
    overlay.isolate(element, { inert: true, ariaHidden: true });
  }
}

function activateBlockingScreen(
  dialog: HTMLElement,
  onEscapeRef: RefObject<(() => void) | undefined>,
) {
  const targetDocument = dialog.ownerDocument;
  const returnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const overlay = createOverlayLease(targetDocument);
  overlay.lockBodyScroll();
  setBlockingBackground(dialog, overlay);

  const observer = new MutationObserver(() => {
    setBlockingBackground(dialog, overlay);
    overlay.reinforce();
  });
  observer.observe(targetDocument.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["inert", "aria-hidden", "style"],
  });

  dialog.focus({ preventScroll: true });

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      onEscapeRef.current?.();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = visibleFocusableElements(dialog);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement
      ? focusable.indexOf(active)
      : -1;
    if (activeIndex < 0) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };
  const handleFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || dialog.contains(target)) return;
    event.stopImmediatePropagation();
    dialog.focus({ preventScroll: true });
  };
  targetDocument.addEventListener("keydown", handleKeyDown, true);
  targetDocument.addEventListener("focusin", handleFocusIn, true);

  return () => {
    observer.disconnect();
    targetDocument.removeEventListener("keydown", handleKeyDown, true);
    targetDocument.removeEventListener("focusin", handleFocusIn, true);
    overlay.release();
    restoreOverlayFocus(targetDocument, returnFocus);
  };
}

export interface BlockingRecoveryScreenProps {
  readonly layer: BlockingRecoveryLayer;
  readonly mode: "alert" | "status";
  readonly title: string;
  readonly description: ReactNode;
  readonly icon: ReactNode;
  readonly children?: ReactNode;
  readonly contentWidth?: string;
  readonly style?: CSSProperties;
  /**
   * Omit this for mandatory recovery blockers. When omitted, Escape is
   * consumed without dismissing the screen or changing recovery state.
   */
  readonly onEscape?: () => void;
}

/**
 * Full-screen recovery boundary shared by bootstrap, terminal erasure, and
 * quarantined-workspace failures. It owns focus and removes the live
 * application from the accessibility tree until recovery is complete.
 */
export function BlockingRecoveryScreen({
  layer,
  mode,
  title,
  description,
  icon,
  children,
  contentWidth = "min(560px, calc(100vw - 40px))",
  style,
  onEscape,
}: BlockingRecoveryScreenProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onEscapeRef = useRef(onEscape);
  const layerDefinition = BLOCKING_RECOVERY_LAYERS[layer];

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    return registerBlockingScreen(
      dialog,
      layerDefinition.priority,
      () => activateBlockingScreen(dialog, onEscapeRef),
    );
  }, [layerDefinition.priority]);

  return (
    <div
      ref={dialogRef}
      className="loading-screen"
      role={mode === "alert" ? "alertdialog" : "status"}
      tabIndex={-1}
      aria-modal={mode === "alert" ? "true" : undefined}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-live={mode === "status" ? "polite" : undefined}
      data-recovery-layer={layer}
      style={{
        ...style,
        position: "fixed",
        inset: 0,
        zIndex: layerDefinition.zIndex,
        background: style?.background ?? "var(--bg)",
      }}
    >
      <span className="brand-mark">{icon}</span>
      <div style={{ width: contentWidth, textAlign: "center" }}>
        <h1 id={titleId} style={{ fontSize: "clamp(24px, 5vw, 34px)" }}>
          {title}
        </h1>
        <div id={descriptionId}>{description}</div>
        {children}
      </div>
    </div>
  );
}
