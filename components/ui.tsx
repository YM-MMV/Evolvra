"use client";

import { type ButtonHTMLAttributes, type PropsWithChildren, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
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

function focusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hidden
      && element.getAttribute("aria-hidden") !== "true"
      && !element.closest("[inert]")
      && element.getClientRects().length > 0);
}

function isTopmostModal(dialog: HTMLElement) {
  if (dialog.closest("[inert]") || dialog.closest("[aria-hidden='true']")) {
    return false;
  }
  const dialogs = [...document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']")];
  return dialogs.filter((candidate) =>
    !candidate.closest("[inert]")
    && !candidate.closest("[aria-hidden='true']")).at(-1) === dialog;
}

function isolateModalBackground(
  dialog: HTMLElement,
  overlay: ReturnType<typeof createOverlayLease>,
) {
  let activeBranch: HTMLElement = dialog;
  let parent = activeBranch.parentElement;
  while (parent) {
    for (const sibling of parent.children) {
      if (sibling !== activeBranch && sibling instanceof HTMLElement) {
        overlay.isolate(sibling, { inert: true, ariaHidden: true });
      }
    }
    if (parent === dialog.ownerDocument.body) break;
    activeBranch = parent;
    parent = parent.parentElement;
  }
}

export function Button({ className = "", variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function Panel({ children, className = "", ...props }: PropsWithChildren<React.HTMLAttributes<HTMLDivElement>>) {
  return <section className={`panel ${className}`} {...props}>{children}</section>;
}

export function ProgressBar({ value, color = "var(--accent)", label }: { value: number; color?: string; label?: string }) {
  const progress = Math.max(0, Math.min(100, value));
  return (
    <div className="progress-wrap" role="progressbar" aria-label={label ?? `${Math.round(progress)}% progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
      <div className="progress-track"><span style={{ width: `${progress}%`, background: color }} /></div>
    </div>
  );
}

export function Modal({ open, onClose, title, eyebrow, children, wide = false }: PropsWithChildren<{ open: boolean; onClose: () => void; title: string; eyebrow?: string; wide?: boolean }>) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    let overlay: ReturnType<typeof createOverlayLease> | null = null;
    const syncModalIsolation = () => {
      if (document.querySelector("[data-recovery-layer]")) {
        overlay?.release();
        overlay = null;
        return;
      }
      if (!overlay) {
        overlay = createOverlayLease(document);
        overlay.lockBodyScroll();
      }
      isolateModalBackground(dialog, overlay);
      overlay.reinforce();
    };
    syncModalIsolation();
    const observer = new MutationObserver(() => {
      if (!dialogRef.current) return;
      syncModalIsolation();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["inert", "aria-hidden", "style"],
    });
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog || !isTopmostModal(dialog)) return;
      const focusable = focusableElements(dialog);
      const currentFocus = document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)
        ? document.activeElement
        : null;
      const preferred = focusable.find((element) =>
        element.hasAttribute("data-modal-autofocus") || element.hasAttribute("autofocus"));
      (currentFocus ?? preferred ?? focusable[0] ?? dialog).focus({ preventScroll: true });
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !isTopmostModal(dialog)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      const currentDialog = dialogRef.current;
      const target = event.target;
      if (
        !currentDialog
        || !isTopmostModal(currentDialog)
        || !(target instanceof Node)
        || currentDialog.contains(target)
      ) return;
      event.stopImmediatePropagation();
      currentDialog.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.clearTimeout(focusTimer);
      observer.disconnect();
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      overlay?.release();
      restoreOverlayFocus(document, returnFocusRef.current);
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div ref={dialogRef} tabIndex={-1} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id={titleId}>{title}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{body}</p>{action}</div>;
}

export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

/** A labelled field region for button collections and other non-form controls. */
export function FieldGroup({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  const labelId = useId();
  return <div className="field"><span id={labelId}>{label}</span><div role="group" aria-labelledby={labelId}>{children}</div>{hint && <small>{hint}</small>}</div>;
}

export function Pill({ children, color }: PropsWithChildren<{ color?: string }>) {
  return <span className="pill" style={color ? { color, borderColor: `${color}45`, background: `${color}14` } : undefined}>{children}</span>;
}
