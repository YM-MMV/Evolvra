"use client";

import { type ButtonHTMLAttributes, type PropsWithChildren, useEffect, useId } from "react";
import { X } from "lucide-react";

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

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", close);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", close);
      document.body.style.overflow = "";
    };
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id={titleId}>{title}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{body}</p>{action}</div>;
}

export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Pill({ children, color }: PropsWithChildren<{ color?: string }>) {
  return <span className="pill" style={color ? { color, borderColor: `${color}45`, background: `${color}14` } : undefined}>{children}</span>;
}
