import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

const paths: Record<string, ComponentChildren> = {
  logo: <><path d="M5 4h9v4H5zM10 16h9v4h-9z" /><path d="M5 8v8h5M14 8h5v8M8 12h8" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  cases: <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4m8-4v4M4 10h16M8 14h8m-8 3h5" /></>,
  layers: <path d="m12 3 10 5-10 5L2 8l10-5ZM3 12l9 5 9-5M3 16l9 5 9-5" />,
  sliders: <><path d="M5 3v18M12 3v18M19 3v18" /><path d="M2 8h6m1 8h6m1-9h6" stroke-width="4" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  export: <path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5" />,
  play: <path d="m9 5 11 7-11 7V5Z" />,
  check: <path d="m5 12 4 4L19 6" />,
  alert: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.1" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></>,
  money: <><rect x="2" y="5" width="20" height="14" rx="2" /><circle cx="12" cy="12" r="3" /></>,
  shield: <><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z" /><path d="m8 12 3 3 5-6" /></>,
  spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />,
  code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" />,
  send: <path d="m4 13 16-9-8 16-2-7-6 0Z" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  file: <path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h8" />,
  folder: <path d="M3 6h7l2 3h9v12H3V6Z" />,
  upload: <path d="M12 17V3m-5 5 5-5 5 5M4 16v5h16v-5" />,
  refresh: <path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 7M4 12l2 7a8 8 0 0 0 13-2" />,
  retry: <path d="M4 9a8 8 0 1 1 0 7M4 3v6h6" />,
  missing: <path d="M7 3h10v18H7V3ZM3 12h18" />,
  duplicate: <><rect x="3" y="3" width="12" height="12" rx="2" /><rect x="9" y="9" width="12" height="12" rx="2" /></>,
  filter: <path d="M3 5h18M6 12h12m-9 7h6" />,
  external: <path d="M14 3h7v7m-1-6-9 9M9 3H3v18h18v-6" />,
  flask: <path d="M9 3h6m-5 0v7L4 20c-.3.6.1 1 1 1h14c.9 0 1.3-.4 1-1l-6-10V3M7 16h10" />,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  eye: <><path d="M2 12S6 5 12 5s10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  link: <path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 -1)" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
  receipt: <path d="M5 3v18l3-2 4 2 4-2 3 2V3l-3 2-4-2-4 2-3-2ZM8 9h8M8 13h8" />,
  question: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-1.1 1-1.7 1.3-1.7 2.7M12 17v.1" /></>,
};

export function Icon({ name, size = 16, className = '' }: { name: string; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class={className}>{paths[name] || paths.info}</svg>;
}

export function Badge({ children, tone = 'plain' }: { children: ComponentChildren; tone?: string }) {
  return <span class={`badge badge-${tone}`}>{children}</span>;
}

export function MockBadge({ children = 'FULL MOCK / SYNTHETIC DATA' }: { children?: ComponentChildren }) {
  return <span class="mock-badge"><span class="status-dot" />{children}</span>;
}

export function Button({ children, action, primary = false, disabled = false, className = '', type = 'button', onClick, ...attrs }: {
  children: ComponentChildren;
  action?: string;
  primary?: boolean;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  onClick?: (event: MouseEvent) => void;
  [key: string]: unknown;
}) {
  return <button {...attrs} type={type} data-action={action} disabled={disabled} class={`btn ${primary ? 'btn-primary' : ''} ${className}`} onClick={onClick}>{children}</button>;
}

export function download(value: unknown, filename: string, type = 'application/json') {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useToast(timeoutMs = 6000) {
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = (message: string, error = false) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, error });
    timer.current = setTimeout(() => setToast(null), timeoutMs);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const node = <div id="toast-root" role="status" aria-live="polite">{toast && <div class={`toast ${toast.error ? 'error' : ''}`}><Icon name={toast.error ? 'alert' : 'check'} size={15} /><span>{toast.message}</span></div>}</div>;
  return { notify, node };
}

export function useEscapeToCloseNav(open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close.current();
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.mobile-nav-button')?.focus({ preventScroll: true }));
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [open]);
}

export function Modal({ title, labelledBy, children, footer, onClose, busy = false, eyebrow, className = 'mock-drawer', initialSelector = '[data-modal-close]' }: {
  title: string;
  labelledBy?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  onClose: () => void;
  busy?: boolean;
  eyebrow?: string;
  className?: string;
  initialSelector?: string;
}) {
  const shell = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const app = document.querySelector<HTMLElement>('#app');
    const priorOverflow = document.body.style.overflow;
    if (app) app.inert = true;
    document.body.style.overflow = 'hidden';
    shell.current?.querySelector<HTMLElement>(initialSelector)?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab' || !shell.current) return;
      const items = [...shell.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled):not([type="file"]),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(item => item.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (!shell.current.contains(document.activeElement) || event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (app) app.inert = false;
      document.body.style.overflow = priorOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const target = document.getElementById('overlay-root');
  if (!target) return null;
  return createPortal(<>
    <div class="overlay-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }} />
    <section ref={shell} class={`drawer ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy || 'dialog-title'}>
      <header class="drawer-header"><div class="drawer-title-row"><div>{eyebrow && <span class="lab-eyebrow">{eyebrow}</span>}<h2 id={labelledBy || 'dialog-title'}>{title}</h2></div><button type="button" class="btn-icon" data-modal-close aria-label="Close dialog" onClick={() => { if (!busy) onClose(); }}><Icon name="close" size={20} /></button></div></header>
      <div class="drawer-content">{children}</div>
      {footer && <footer class="drawer-footer">{footer}</footer>}
    </section>
  </>, target);
}
