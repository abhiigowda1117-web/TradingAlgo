import { loadEnv, paths, type Env, type TradingConfig } from './config';
import { KiteMarketData } from './data/kiteMarketData';
import type { MarketData } from './data/types';
import { YahooData } from './data/yahoo';
import type { Broker } from './trading/brokers/broker';
import { KiteBroker } from './trading/brokers/kiteBroker';
import { KiteClient } from './trading/brokers/kiteClient';
import { PaperBroker } from './trading/brokers/paperBroker';

export function kiteClient(env: Env): KiteClient {
  const { apiKey, accessToken } = env.kite;
  if (!apiKey || !accessToken) throw new Error('KITE_API_KEY and KITE_ACCESS_TOKEN must be set (run `npm run kite-login`).');
  return new KiteClient(apiKey, accessToken);
}

export function marketData(env: Env, cfg: TradingConfig): MarketData {
  return env.marketData === 'kite' ? new KiteMarketData(kiteClient(env), cfg.engine.exchange) : new YahooData(cfg.engine.exchange);
}

export function broker(env: Env, cfg: TradingConfig, market: MarketData): Broker {
  if (env.tradingMode === 'live') {
    return new KiteBroker(kiteClient(env), { exchange: cfg.engine.exchange, stopLimitBufferPct: cfg.engine.stopLimitBufferPct });
  }
  return new PaperBroker(market, { file: paths.paperAccount, initialCash: env.paperCapital, costPct: cfg.backtest.costPct });
}

export { loadEnv };
