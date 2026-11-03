import { Card, ErrorBox, Loading, PageHeader, ComingSoon } from '../components/ui';
import { inr, pct } from '../lib/format';
import type { Settings } from '../lib/types';
import { useApi } from '../lib/useApi';

export const Research = () => (
  <ComingSoon
    title="Company Research"
    description="Search any NSE company for fundamentals, technicals, news, NSE announcements, peer comparison and a rule-based summary."
    items={['Company search box', 'Overview, fundamentals and trends with charts', 'Technical analysis (EMA, RSI, MACD, support/resistance)', 'News and NSE announcements with sources', 'Peer comparison', 'Saved reports in the database']}
    cli={['npm run company -- Reliance', 'npm run research -- RELIANCE', 'npm run dashboard   (local research page)']}
  />
);

export const Reports = () => (
  <ComingSoon
    title="Reports"
    description="Saved research reports, company-study rankings and backtest reports in one place."
    items={['Company study rankings by date', 'Saved company research reports', 'Backtest reports with full metrics', 'Download as Markdown/PDF']}
    cli={['npm run study', 'npm run portfolio -- --trades']}
  />
);

export function Risk() {
  const { data, error } = useApi<Settings>('/api/settings');
  return (
    <>
      <PageHeader title="Risk Management" description="Current limits enforced by the engine (read-only). Live exposure monitoring and limit editing come in Phase 2." />
      {error && <ErrorBox message={error} />}
      {!data ? <Loading /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Per trade">
            <ul className="space-y-1 text-sm">
              <li>Risk per trade: <b>{pct(data.risk.riskPerTrade)}</b> of equity (after costs and slippage)</li>
              <li>Max single position: <b>{pct(data.risk.maxPositionPct)}</b> of equity</li>
              <li>Max order value: <b>{inr(data.risk.maxOrderValue)}</b></li>
              <li>Skip if live price deviates more than <b>{pct(data.risk.maxPriceDeviationPct)}</b> from the candle close</li>
            </ul>
          </Card>
          <Card title="Portfolio">
            <ul className="space-y-1 text-sm">
              <li>Max open positions: <b>{data.risk.maxOpenPositions}</b></li>
              <li>Max total exposure: <b>{pct(data.risk.maxTotalExposurePct)}</b> of equity</li>
              <li>Daily loss limit: <b>{pct(data.risk.maxDailyLossPct)}</b> (no new entries for the rest of the day)</li>
              <li>Stop-loss: {data.strategy.stopAtr}× ATR initial, {data.strategy.trailAtr}× ATR trailing, broker-confirmed</li>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

export const NotFound = () => <PageHeader title="Page not found" description="Use the menu to navigate." />;
