import { createContext, useContext, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { money } from '../lib/format';

export type Tone = 'plain' | 'green' | 'amber' | 'red' | 'blue';

/** While a request runs, every action button is disabled (same as the original `S.busy`). */
export const BusyContext = createContext(false);

export function Badge({ children, tone = 'plain' }: { children: ReactNode; tone?: Tone | string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function MockBadge() {
  return <span className="mock-badge"><span className="status-dot"></span>FULL MOCK / SYNTHETIC DATA</span>;
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  primary?: boolean;
  /** Mirrors the original data-action attribute (used by tests and focus return). */
  action: string;
  onClick?: () => void;
}

export function Button({ primary = false, action, disabled = false, children, onClick, ...rest }: ButtonProps) {
  const busy = useContext(BusyContext);
  return (
    <button type="button" className={`btn ${primary ? 'btn-primary' : ''}`} data-action={action}
      disabled={busy || disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

export function Heading({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <section className="page-heading">
      <div className="page-title"><h1>{title}</h1><p>{description}</p></div>
      <div className="heading-actions">{actions}</div>
    </section>
  );
}

/** "+21.97 USD · +989.01 EUR" */
export function Currencies({ data }: { data: Record<string, string> | undefined }) {
  const entries = Object.entries(data || {});
  return (
    <>
      {entries.map(([c, v], i) => (
        <span key={c}>
          {i > 0 && ' · '}
          <span className="money">{money(v, true)} <small>{c}</small></span>
        </span>
      ))}
    </>
  );
}

export function JsonBlock({ title, data }: { title: string; data: unknown }) {
  return (
    <section className="mock-json-block">
      <h3>{title}</h3>
      <pre>{typeof data === 'string' ? data : JSON.stringify(data, null, 2)}</pre>
    </section>
  );
}
