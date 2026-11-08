import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MockBadge } from './primitives';

const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),summary,a[href]';

interface DrawerProps {
  eyebrow: string;
  title: string;
  titleId: string;
  labels?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  closeLabel: ReactNode;
  closeAction: string;
  busy: boolean;
  onClose: () => void;
}

/**
 * The evidence drawer: a modal dialog in #overlay-root. While open, the app root is inert,
 * the body does not scroll, Tab is trapped inside, and Escape closes it (unless busy).
 */
export function Drawer({ eyebrow, title, titleId, labels, footer, children, closeLabel, closeAction, busy, onClose }: DrawerProps) {
  const ref = useRef<HTMLElement>(null);
  const target = document.getElementById('overlay-root');

  useEffect(() => {
    const app = document.getElementById('app');
    if (app) app.inert = true;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLButtonElement>(`button[data-action="${closeAction}"]`)?.focus();
    return () => {
      if (app) app.inert = false;
      document.body.style.overflow = '';
    };
  }, [closeAction]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const first = items[0], last = items.at(-1);
        const inside = ref.current.contains(document.activeElement);
        if (!inside) { first?.focus(); event.preventDefault(); }
        else if (event.shiftKey && document.activeElement === first) { last?.focus(); event.preventDefault(); }
        else if (!event.shiftKey && document.activeElement === last) { first?.focus(); event.preventDefault(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  if (!target) return null;
  const close = () => { if (!busy) onClose(); };
  return createPortal(
    <>
      <div className="overlay-backdrop" data-action={closeAction} onClick={close}></div>
      <section ref={ref} className="drawer mock-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="drawer-header">
          <div className="drawer-title-row">
            <div><span className="lab-eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div>
            <button type="button" className="btn-icon" data-action={closeAction} aria-label="Close dialog" onClick={close}>{closeLabel}</button>
          </div>
          <div className="drawer-labels"><MockBadge />{labels}</div>
        </header>
        <div className="drawer-content">{children}</div>
        <footer className="drawer-footer">{footer}</footer>
      </section>
    </>,
    target,
  );
}

/** Remembers the element that opened a dialog and gives focus back to it on close. */
export function useFocusReturn() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    remember: () => { opener.current = document.activeElement as HTMLElement | null; },
    restore: (fallbackSelector: string) => {
      const el = opener.current;
      requestAnimationFrame(() => {
        if (el && document.contains(el)) el.focus();
        else document.querySelector<HTMLElement>(fallbackSelector)?.focus();
      });
    },
  };
}
