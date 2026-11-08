import { money } from '../../../shared';
import type { Report } from '../domain';

export function CurrencyCards({ report }: { report: Report }) {
  return (
    <div className="currency-cards">
      {['USD', 'EUR'].map(c => (
        <section className="currency-card" key={c}>
          <div className="currency-heading"><strong>{c}</strong><span>DESTINATION − SOURCE</span></div>
          <div className="currency-gap">{money(report.gap[c], true)}<small>{c}</small></div>
          <div className="currency-detail">
            <span>Source ledger<strong>{money(report.source_totals[c])}</strong></span>
            <span>Effective destination<strong>{money(report.destination_effective_totals[c])}</strong></span>
          </div>
        </section>
      ))}
    </div>
  );
}
