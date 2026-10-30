# TradingAlgo

Two algorithms for Indian stocks (NSE), written in TypeScript:

1. **Company study**: screens a universe of companies on fundamentals, scores them, reads recent news sentiment, writes a research report per company, and produces a ranked **watchlist**.
2. **Trading algo**: a daily swing-trading engine that **only buys stocks on the company-study watchlist**, when its technical entry signal fires. It sizes positions by risk, protects every position with a stop-loss order, and trades through **Zerodha Kite**, either live or on a paper account.

```
 config/study.json                                   config/trading.json
        │                                                    │
 ┌──────▼───────────────────────────┐   data/watchlist.json  ┌▼──────────────────────────────┐
 │ Company study (npm run study)    │ ─────────────────────▶ │ Trading engine (npm run trade)│
 │  fundamentals (Yahoo Finance)    │                        │  EMA crossover + RSI + ATR    │
 │  screener → score 0-100          │   reports/<date>/*.md  │  risk sizing, daily-loss halt │
 │  news sentiment (Google News)    │ ───▶ you read these    │  exchange stop-loss orders    │
 │  combined score → top N          │                        │  Paper broker | Kite (live)   │
 └──────────────────────────────────┘                        └───────────────────────────────┘
```

> **Risk warning.** This is software, not investment advice. Automated trading can lose money quickly, including through bugs, bad data, or outages. Backtest it, run it on paper for weeks, then go live with small size.

## Setup

Node 20+ required.

```bash
npm install
cp .env.example .env     # defaults to paper trading with Yahoo data
npm test                 # 44 offline tests
```

## 1. Company study

```bash
npm run study                          # whole universe in config/study.json
npm run study -- --symbols INFY,TCS    # just these
npm run report -- INFY                 # print one company's report to the terminal
```

For each company it:

| Step | What it does | Configure in `config/study.json` |
|---|---|---|
| **Screener** | Pass/fail rules, e.g. market cap ≥ ₹10,000 cr, ROE ≥ 10%, debt/equity ≤ 1.5, profitable | `screen.rules`, `screen.onMissing` |
| **Fundamental score** | 0-100 from ROE, revenue & earnings growth, debt, margins, P/E, P/B, current ratio, dividend yield. Each metric scores linearly between a `bad` value (0) and a `good` value (100) and is weighted. Missing metrics are left out and reported as lower *coverage*. | `scoring` |
| **News sentiment** | Pulls the last 14 days of Google News headlines, scores each with a finance word list (handles phrases like "beats estimates" and negation like "did not fall"), and weights recent news more | `sentiment` |
| **Combined score** | 75% fundamentals + 25% sentiment | `combine` |
| **Watchlist** | Passed the screen, sentiment not too negative, score ≥ 55, top 10 | `watchlist` |
| **Reports** | `reports/<date>/README.md` ranks every company; `reports/<date>/<SYMBOL>.md` has scores, the metric table, screen results, strengths, red flags, best/worst headlines, and a technical snapshot from the trading strategy | |

Outputs: `data/watchlist.json` (read by the trading engine) and `reports/<date>/`.

Banks and NBFCs often have no debt/equity or current ratio on Yahoo. With `"onMissing": "pass"` they are not penalised for missing data; set it to `"fail"` to be strict.

## 2. Trading algo

### Strategy (daily candles, long only, delivery/CNC)

- **Entry**: 20 EMA crosses above 50 EMA, close above the 200 EMA, RSI(14) between 50 and 70, **and the stock is on the watchlist**.
- **Initial stop**: 2 × ATR(14) below the entry.
- **Trailing stop**: 3 × ATR below the highest close since entry. It only moves up.
- **Exit**: stop hit, or 20 EMA falls below 50 EMA.

### Risk controls (`config/trading.json` → `risk`)

| Setting | Default | Meaning |
|---|---|---|
| `riskPerTrade` | 1% | Max loss per trade if the stop is hit, as a share of equity |
| `maxPositionPct` | 20% | Max size of one position |
| `maxOpenPositions` | 5 | |
| `maxDailyLossPct` | 2% | If equity falls this much in a day, no new entries until tomorrow |
| `maxOrderValue` | ₹2,00,000 | Hard cap per order |

Also: the engine refuses new entries if the watchlist is missing or older than `watchlistMaxAgeDays` (7), and it halts if a file named `STOP` exists in the project root.

### Backtest

```bash
npm run backtest                                  # watchlist symbols, 5 years
npm run backtest -- --symbols INFY,TCS --years 8 --trades
npm run backtest -- --csv mydata/INFY.csv         # any CSV with date,open,high,low,close[,volume]
```

Reports return, CAGR, max drawdown, Sharpe, trade count, win rate, profit factor, average R-multiple and time in market, net of costs (0.12% per side by default, which roughly covers STT and charges on delivery trades) and slippage.

> Backtesting the *combined* system has a look-ahead bias: the watchlist uses **today's** fundamentals, which were not known in the past. Treat backtests as a check of the trading rules, not a forecast.

### How the engine runs

`npm run trade` starts a loop that runs during NSE hours (09:15-15:30 IST, Monday to Friday, minus `engine.holidays`):

- **Every `pollSeconds` (30 s)**: on a new day, it records starting equity and re-places each position's stop-loss order (Kite stop orders are DAY orders and expire at the close). It also detects stop fills and positions closed by hand, and checks the daily loss limit. If the price has already gapped below a stop at the open, it sells straight away.
- **Once a day at `evaluateAt` (15:10 IST)**: it runs exit checks and trails stops on open positions, then looks for entries among watchlist stocks in score order.

State lives in `data/state.json`, every trade is appended to `data/trades.jsonl`, and the log is `logs/engine.log`. You can restart the engine at any time and it carries on where it stopped.

```bash
npm run trade                    # paper trading (simulated fills at live prices)
npm run trade -- --status        # positions, P&L and equity
npm run trade -- --once          # a single pass, for running from cron or a scheduler
touch STOP                       # halt the engine (rm STOP to allow restarting)
```

## Going live with Zerodha Kite

1. Create a Kite Connect app at <https://developers.kite.trade> and put `KITE_API_KEY` and `KITE_API_SECRET` in `.env`.
2. **Each trading day**, run `npm run kite-login`, open the printed URL, log in, paste the redirect URL back, and copy `KITE_ACCESS_TOKEN` into `.env`. Kite tokens expire every morning. The engine stops with a clear message if the token is invalid.
3. Enable **DDPI** (or authorise holdings via TPIN) on your Zerodha account. Without it, stop-loss sell orders on stocks held overnight are rejected.
4. Check Zerodha's and SEBI's current rules for retail API/algo trading, such as static-IP whitelisting and algo registration, and make sure your setup complies.
5. Optional: set `MARKET_DATA=kite` to use Kite candles instead of Yahoo. This needs the Kite historical-data add-on.
6. Set `TRADING_MODE=live` in `.env` **and** start with `npm run trade -- --live`. Both are required, and you get 10 seconds to abort before it starts.

The engine manages only positions it opened itself; your other holdings are not touched.

## Project layout

```
config/           study.json (universe, screen, scoring), trading.json (strategy, risk, engine)
src/study/        screener, scoring, sentiment, report, watchlist, study pipeline
src/trading/      indicators, strategy, risk, backtest, engine
src/trading/brokers/  Broker interface, PaperBroker, KiteBroker, KiteClient (REST)
src/data/         Yahoo Finance, Google News RSS, Kite market data, CSV loader
src/cli/          study, report, backtest, trade, kite-login
test/             offline tests (no network needed)
```

## Known limitations

- Yahoo Finance and Google News are free, unofficial sources. They can be delayed, have gaps, or change format. For serious use, swap in a paid fundamentals feed by implementing `FundamentalsProvider` in `src/data/types.ts`.
- The sentiment model is a word list, not a language model. It reads headlines, not articles.
- Paper fills are at the polled last price; a stop is only seen as triggered if a poll catches the price at or below it.
- NSE holidays are not built in. Add them to `engine.holidays` (`"YYYY-MM-DD"`). Kite also rejects orders on holidays.
