/** Shared UI pieces: dialogs, toasts, icons and formatting helpers. */

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

// --- Formatting ----------------------------------------------------------------

/** "now", "45s", "12m", "3h 20m", "2d 4h", "3w" */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  return `${Math.round(d / 7)}w`;
}

export function formatAgo(timestamp: number | null, now: number): string {
  if (timestamp === null) return "never";
  const days = Math.floor((now - timestamp) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

// --- Icons (inline SVG, inherit currentColor) ----------------------------------

const paths: Record<string, string> = {
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  cards: "M7 3h12v15H7zM4 6v15h12",
  stats: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  x: "M18 6L6 18M6 6l12 12",
  plus: "M12 5v14M5 12h14",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  upload: "M12 21V9M7 14l5-5 5 5M5 3h14",
  chevron: "M9 6l6 6-6 6",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
  trash: "M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3",
};

export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

// --- Dialog ----------------------------------------------------------------------

export interface DialogAction<T> {
  label: string;
  value: T;
  tone?: "primary" | "danger" | "plain";
}

interface DialogRequest {
  title: string;
  body?: ComponentChildren;
  actions: DialogAction<unknown>[];
  resolve: (value: unknown) => void;
}

let showDialog: ((req: DialogRequest) => void) | null = null;

/**
 * Ask the user to choose. Resolves with the chosen action's value, or null if
 * dismissed (Escape or tapping outside).
 */
export function ask<T>(title: string, body: ComponentChildren, actions: DialogAction<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    if (!showDialog) throw new Error("DialogHost not mounted");
    showDialog({ title, body, actions: actions as DialogAction<unknown>[], resolve: resolve as (v: unknown) => void });
  });
}

/** Shorthand for a yes/cancel question. */
export async function confirmAction(title: string, body: ComponentChildren, label: string, danger = false): Promise<boolean> {
  const choice = await ask(title, body, [
    { label: "Cancel", value: false, tone: "plain" },
    { label, value: true, tone: danger ? "danger" : "primary" },
  ]);
  return choice === true;
}

export function DialogHost() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    showDialog = setRequest;
    return () => {
      showDialog = null;
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request]);

  const close = (value: unknown) => {
    request?.resolve(value);
    setRequest(null);
  };

  if (!request) return null;
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && close(null)}>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{request.title}</h2>
        {request.body && <div class="dialog-body">{request.body}</div>}
        <div class="dialog-actions">
          {request.actions.map((a, i) => (
            <button
              key={a.label}
              ref={i === request.actions.length - 1 ? first : undefined}
              class={`btn ${a.tone === "primary" ? "btn-primary" : a.tone === "danger" ? "btn-danger" : ""}`}
              onClick={() => close(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Toast -------------------------------------------------------------------------

interface ToastState {
  message: string;
  action?: { label: string; run: () => void };
  id: number;
}

let showToast: ((t: Omit<ToastState, "id">) => void) | null = null;

/** Show a short message at the bottom, optionally with an action like Undo. */
export function toast(message: string, action?: ToastState["action"]): void {
  showToast?.({ message, action });
}

export function ToastHost() {
  const [current, setCurrent] = useState<ToastState | null>(null);

  useEffect(() => {
    let counter = 0;
    showToast = (t) => setCurrent({ ...t, id: ++counter });
    return () => {
      showToast = null;
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setCurrent(null), current.action ? 6000 : 3000);
    return () => clearTimeout(timer);
  }, [current]);

  if (!current) return null;
  return (
    <div class="toast" role="status">
      <span>{current.message}</span>
      {current.action && (
        <button
          class="toast-action"
          onClick={() => {
            current.action!.run();
            setCurrent(null);
          }}
        >
          {current.action.label}
        </button>
      )}
    </div>
  );
}

/** Turn an unknown error into something readable. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
