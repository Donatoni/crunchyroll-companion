/**
 * Lightweight, self-contained toast shown after an auto-skip. Kept dependency-free
 * and style-isolated (inline styles + a single fixed container) so it never
 * collides with Crunchyroll's own CSS.
 */

const CONTAINER_ID = 'crunchyroll-companion-toast-root';

function ensureContainer(): HTMLElement {
  let el = document.getElementById(CONTAINER_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = CONTAINER_ID;
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    alignItems: 'center',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.documentElement.appendChild(el);
  return el;
}

interface ToastOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

export function showToast({
  message,
  actionLabel,
  onAction,
  durationMs = 5000,
}: ToastOptions): void {
  const container = ensureContainer();

  const toast = document.createElement('div');
  Object.assign(toast.style, {
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    background: 'rgba(20, 20, 24, 0.95)',
    color: '#fff',
    font: "500 13px/1.2 'Lato', system-ui, sans-serif",
    padding: '10px 14px',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    border: '1px solid rgba(255,255,255,0.08)',
    opacity: '0',
    transition: 'opacity 0.2s ease, transform 0.2s ease',
    transform: 'translateY(8px)',
  } satisfies Partial<CSSStyleDeclaration>);

  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  // `timer` is assigned at the bottom (after the toast is in the DOM); dismiss
  // only ever runs later (click / timeout), so the closure read is safe.
  const dismiss = () => {
    window.clearTimeout(timer);
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    window.setTimeout(() => toast.remove(), 200);
  };

  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    Object.assign(btn.style, {
      cursor: 'pointer',
      background: '#f47521', // Crunchyroll orange
      color: '#fff',
      border: 'none',
      borderRadius: '5px',
      padding: '5px 10px',
      font: "700 12px/1 'Lato', system-ui, sans-serif",
    } satisfies Partial<CSSStyleDeclaration>);
    btn.addEventListener('click', () => {
      onAction();
      dismiss();
    });
    toast.appendChild(btn);
  }

  container.appendChild(toast);
  // Trigger enter transition on next frame.
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  const timer = window.setTimeout(dismiss, durationMs);
}
