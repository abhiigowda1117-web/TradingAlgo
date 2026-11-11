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

Node 22+ required ([nodejs.org](https://nodejs.org), LTS). Run every command **inside the project folder**.

```bash
cd TradingAlgo           # Windows Command Prompt: cd %USERPROFILE%\TradingAlgo
npm install
cp .env.example .env     # Command Prompt: copy .env.example .env. Defaults to paper trading with Yahoo data
npm test                 # offline tests (no network, no real orders)
```

## 1. Company study

```bash
npm run study                          # whole universe in config/study.json
npm run study -- --symbols INFY,TCS    # just these
npm run report -- INFY                 # print one company's report to the terminal
```

Yahoo limits how many requests one internet connection may make. When it refuses (HTTP 429 "Too Many Requests"), the study waits and retries (10 s, 30 s, 60 s). If Yahoo still refuses, the study stops early and does **not** overwrite the previous watchlist. Wait 15–30 minutes and start with a few symbols (`npm run study -- --symbols INFY,TCS,ITC`).

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

### Stock-picking styles (famous investors' rules)
On the **Market Watchlist** page, choose whose rules build the watchlist, then press **Refresh watchlist now**. From the command line: `npm run study -- --profile buffett`. Each style is the investor's published rules applied to the study's free Yahoo data (with earnings yield, PEG and P/E × P/B worked out from it). The investor styles are strict: a company with a missing number fails rather than passes.

| Style | Investor | Main rules | Pairs with (Strategy Lab) |
|---|---|---|---|
| Balanced (default) | AlgoTrade | `config/study.json` as above | EMA Trend |
| Quality at a fair price | Warren Buffett | ROE ≥ 15%, D/E ≤ 0.5, net margin ≥ 10%, operating margin ≥ 15%, positive free cash flow, P/E ≤ 35 | Buy right, sit tight |
| Defensive value | Benjamin Graham | P/E ≤ 15, P/E × P/B ≤ 22.5, current ratio ≥ 2, D/E ≤ 0.5, pays a dividend, market cap ≥ ₹5,000 cr | Buy right, sit tight |
| Magic Formula | Joel Greenblatt | Ranked 50/50 on earnings yield and return on assets; no banks, financials or utilities | Buy right, sit tight |
| Growth at a reasonable price | Peter Lynch | PEG ≤ 1, earnings growth 15–50%, D/E ≤ 0.6 | Minervini Trend Template |
| Growth and quality at a sensible price | Rakesh Jhunjhunwala (inspired) | ROE ≥ 15%, earnings growth ≥ 15%, sales growth ≥ 10%, P/E ≤ 45, PEG ≤ 2, D/E ≤ 1.5 | Buy right, sit tight |
| QGLP | Raamdeo Agrawal | ROE ≥ 20%, earnings and sales growth ≥ 15%, operating margin ≥ 15%, market cap ≥ ₹20,000 cr, PEG ≤ 1.5 | Buy right, sit tight |
| CAN SLIM fundamentals | William O'Neil | Earnings growth ≥ 25%, sales growth ≥ 20%, ROE ≥ 17% | CAN SLIM breakout |

Limits: Buffett and Jhunjhunwala never published a formula, so those two styles are close readings of what they said they look for, not their actual methods. Free data has one year of numbers, so moats, management quality and multi-year records cannot be checked. A style only filters and ranks; it never buys anything.

## AlgoTrade website (private, runs on your computer)

A private, password-protected web app (React + Vite + Tailwind frontend, Node REST API, built-in database).

- **Pages:** Dashboard, Company Research, Market Watchlist, Trading Engine, Paper Portfolio, Strategy Lab, Backtesting, Risk Management, Trade History, Reports and Settings.
- **Paper trading only** from the website; the engine never runs live from here.

### Setup on any computer (Windows)

Nothing to install except **Node.js 22.13 or newer** (LTS from https://nodejs.org) and **Git** (https://git-scm.com). No database server: the website keeps its data in a file, `data/algotrade.db`.

1. **Get the code** (PowerShell):
   ```
   cd $HOME
   git clone -b feature/web-platform-foundation https://github.com/abhiigowda1117-web/TradingAlgo.git TradingAlgo
   ```
2. **Start it:** double-click `start-algotrade.cmd` in the `TradingAlgo` folder. The first time it creates `.env` with safe defaults, installs, builds and opens the browser.
3. **Create your account** on the page that appears (only possible on the computer running AlgoTrade, and only while no account exists).

**Move to another computer:** stop the website, copy the `TradingAlgo\data` folder (accounts, saved research, paper portfolio, watchlist, backtests) into the new computer's `TradingAlgo` folder, and start it there. Phones and other devices open it through Tailscale or home Wi-Fi with no address settings: the site accepts its own IP address or Tailscale name automatically.

**PostgreSQL instead (optional, e.g. on a hosting server):** set `DATABASE_URL=postgres://...` in `.env`; tables are created on the first start.

### Run it

```
npm run web:build
npm run server
```
Open **http://localhost:3001** and sign in. Press Ctrl+C to stop.

**Windows, one click:** double-click `start-algotrade.cmd` in the TradingAlgo folder. It stops any old server on port 3001, runs `git pull`, installs anything new, rebuilds the website, starts the server and opens the browser. Keep its window open; closing it stops the website.

### Strategy Lab: nine strategies, compared honestly
The **Strategy Lab** page describes nine long-only strategies in plain words and backtests all of them on the same stocks, period, costs and risk rules against simply holding the NIFTY 50:

| Strategy | Style | Buys | Sells |
|---|---|---|---|
| EMA Trend (default) | Trend following | EMA 20 crosses above EMA 50, above EMA 200, RSI 50–70 | EMA 20 below EMA 50, or 3-ATR trailing stop |
| Donchian Breakout | Breakout (Turtle) | Fresh close above the previous 55-day high | Close below the previous 20-day low (stop trails to it) |
| 52-Week High Momentum | Momentum | Fresh 20-day closing high within 5% of the 52-week high, above rising 50/200-day averages | Close below the 50-day average, or 3-ATR trailing stop |
| RSI-2 Pullback | Mean reversion | RSI(2) below 10 while above the 200-day average | Close above the 5-day average, or the 2-ATR stop |
| Supertrend | Trend following | Supertrend (10, 3) flips up | Supertrend flips down (stop trails the line) |
| Minervini Trend Template | Momentum (Mark Minervini) | All 8 Trend Template rules (above rising 50/150/200-day averages, ≥ 30% above the 52-week low, within 25% of the high), then a fresh 20-day closing high on volume ≥ 1.4× average | Close below the 50-day average; stop at most 8% below the buy, trailing 3 ATR |
| CAN SLIM breakout | Growth breakout (William O'Neil) | Close breaks the previous 50-day high, within 15% of the 52-week high, on volume ≥ 1.4× average | +25% take profit, close below the 50-day average, or the 8% stop |
| Weinstein Stage 2 | Stage analysis (Stan Weinstein) | Above a rising 150-day (30-week) average, fresh 50-day breakout on volume ≥ 2× average | Close below the 150-day average (stop trails to 5% below it) |
| Buy right, sit tight | Long-term investing (Jhunjhunwala / QGLP) | Above a rising 200-day average and no more than 15% above it | Only when the close is more than 10% below the 200-day average |

Settings are standard textbook values (from each trader's own book) and were not tuned on the data. Minervini's relative-strength ranking and O'Neil's "M" (overall market direction) need data on the whole market and are not automated yet. The results show the full period and an unseen **test period**; a strategy that lags the NIFTY 50 in the test period has no proven edge. Press **Use for paper trading** to choose the strategy for the paper engine's new buys. Each position remembers the strategy that bought it and is sold by that strategy's rules. From the command line: `npm run portfolio -- --strategy donchian`, or `npm run portfolio -- --compare`.

### Control everything from the website (paper trading only)
No terminal needed once the site is running:
- **Trading Engine** page: **Start engine** / **Stop engine**, and the kill switch (**Normal**, **Pause new buys**, **Sell everything & stop**), plus the engine's live log. Only one engine can run at a time (`data/engine.lock`), whether started here or with `npm run trade`; a second one refuses to start.
- **Paper Portfolio** page: **Buy** any NSE stock and **Sell** any position. The running engine carries out each order within a minute, during market hours only, with the same risk rules as its own trades (about 1% of the account at risk, at most 20% in one stock, at most 5 positions, daily loss limit, kill switch) and places a stop-loss at once. Hand-picked positions keep a trailing stop and are not closed by the strategy's exit rule. Orders not handled within 30 minutes expire.
- **Market Watchlist** page: **Refresh watchlist now** (runs the company study). **Backtesting** page: **Run backtest now**.

The website never starts the engine in live mode and never sends orders itself. Every button press is logged with the username. Accounts made with `npm run user:create -- --username friend --viewer` can look but cannot use any of these buttons.


For frontend development with live reload, use two windows: `npm run server` in one and `npm run web:dev` in the other, then open http://localhost:5173.

### Live prices from Zerodha Kite (optional)

By default the website uses Yahoo Finance: free, but about 15 minutes delayed. To show exchange prices
from your own Zerodha Kite Connect account instead:

1. Create a Kite Connect app at https://developers.kite.trade (paid; check the current price there).
   Charts also need the historical-data add-on. Set the app's redirect URL to `http://127.0.0.1`.
2. In `.env` set `KITE_API_KEY`, `KITE_API_SECRET` and `WEB_MARKET_DATA=kite`.
3. Each morning (tokens expire around 6 AM IST) run `npm run kite-login`, open the link, log in, and paste
   the address you are sent to. The new token is saved into `.env` for you (it is never printed), and the
   website starts using it within 30 seconds; no restart needed.

What changes: the price, today's change, the Market Movers board, the ticker tape, Market Pulse and the
charts come from Kite. Company names, the 52-week range, market cap and P/E still come from Yahoo, because
Kite's quote API does not include them. Weekly and monthly chart candles are built from Kite's daily
candles. Every board, price and chart says which source it used. If Kite fails (expired login, missing
add-on, outage), the site falls back to Yahoo and shows a yellow note with the reason.

Safety: the website only uses Kite's read endpoints (`/quote`, `/instruments/historical`) through a
separate read-only client, keys never leave the server, and the website still cannot place orders.

### Security
- **Passwords:** scrypt-hashed. Sign-in is locked for 15 minutes after 5 failed attempts.
- **Sessions:** an HttpOnly, SameSite=Strict cookie. The database stores only a SHA-256 of the session ID. Sessions expire after 12 hours.
- **Requests:** state-changing requests need a CSRF token. CORS allows only `APP_ORIGIN`. The API is limited to 300 requests per 5 minutes per IP address, with strict security headers (CSP, frame denial).
- **Secrets:** broker keys and the database URL stay in `.env` on the server and are never sent to the browser.
- **Production:** set `NODE_ENV=production` and `COOKIE_SECURE=true`, and serve the site over HTTPS. Deployment is Phase 3; Phase 1 is for local use.

## Today's update on one company

```bash
npm run company -- Reliance                 # by name
npm run company -- BEL                      # or by NSE symbol
npm run company -- "Bharat Electronics" --days 7
```

Prints, in the terminal:
- **Price:** today's price and change, day range, volume against the 3-month average, 52-week range, market cap and P/E.
- **Trend:** EMA 20/50/200, RSI, MACD, recent returns, and nearest support and resistance.
- **News:** the latest headlines with category and tone tags.
- **Announcements:** the latest NSE announcements, or a link when NSE blocks the request.

Prices are delayed, not real-time. It is read-only and never trades.

## Company research (any NSE stock)

```bash
npm run research -- HIKAL                         # report -> reports/research/HIKAL-<date>.md and .json
npm run research -- HIKAL --peers DIVISLAB,LAURUSLABS
npm run dashboard                                 # then open http://localhost:3000, type a symbol, click Analyze
```

The report covers:
1. **Overview:** business description, sector, industry and key people.
2. **Fundamentals:** growth, EPS, ROE, ROCE, debt, margins, cash flow and valuation, with annual and quarterly trends.
3. **Technicals:** EMA 20/50/200, RSI, MACD, volume, support/resistance, trend and returns.
4. **News and NSE announcements.**
5. **Peer comparison.**
6. **Rule-based summary:** business quality, financial strength, growth, risks, valuation, technical outlook, and bullish and bearish scenarios.

The dashboard shows the same content with charts.

**Data rules:**
- **Labels:** every figure is labelled **Reported** (from the source as-is), **Calculated** (formula shown), **Estimate** (an analyst forecast) or **Not Available**. Missing data is never filled in.
- **Sources:**
  - Yahoo Finance for the profile, statements and prices. These are third-party data, delayed rather than real-time, and should be checked against filings.
  - Google News for headlines.
  - NSE's website for announcements. NSE has no official API: when it blocks the request, the report says Not Available and links to the official NSE/BSE pages.
- **Products and segments:** there's no free structured source, so the report points to the annual report instead.
- **Peers:** taken from `config/peers.json` (edit it, or pass `--peers`). Stocks with no configured peers show none.
- **Interpretation:** fixed rules, with no price targets or predictions.
- **Separation:** the research and dashboard code cannot import any trading or broker code (a test enforces this). The dashboard listens on this computer only.

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
| `maxTotalExposurePct` | 80% | Max combined value of all positions |
| `maxOpenPositions` | 5 | Counts orders still in flight |
| `maxDailyLossPct` | 2% | If equity falls this much in a day, no new entries until tomorrow |
| `maxOrderValue` | ₹2,00,000 | Hard cap per order |
| `maxPriceDeviationPct` | 3% | Skip an entry if the live price is this far from the latest candle close |

Sizing uses the worst-case loss per share: entry slippage, a stop-limit fill at the bottom of its band, exit slippage, and costs on both sides (`backtest.costPct`, `backtest.slippagePct`, `engine.stopLimitBufferPct`). The config is validated on load, and out-of-range values (for example `riskPerTrade` above 5%) stop the program.

The engine also refuses new entries whenever anything is uncertain: the watchlist is missing or older than `watchlistMaxAgeDays`; an order's outcome is unknown; a position is not protected by a broker-confirmed stop; the broker's position or order lookup failed; equity can't be valued; or the kill switch is on.

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

- **Every `pollSeconds` (30 s)**: it reconciles every order and position with the broker, keeps a broker-confirmed stop on each position (re-placing it each morning, because Kite stop orders are DAY orders), applies fills, and checks the daily loss limit. If the price has already gapped below a stop, it sells.
- **Once a day at `evaluateAt` (15:10 IST)**: it runs exit checks and trails stops on open positions, then looks for entries among watchlist stocks in score order.

State lives in `data/state.json` (written atomically), every fill is appended to `data/trades.jsonl`, and the log is `logs/engine.log`. You can restart the engine at any time and it carries on where it stopped.

```bash
npm run trade                    # paper trading (simulated fills at live prices)
npm run trade -- --status        # positions, stop protection, open orders, equity
npm run trade -- --once          # a single pass, for running from cron or a scheduler
```

### Order safety

- **Durable order intents.** Before any order is sent, the engine saves an *intent* with a unique ID, which is also sent to the broker as the order tag. Each tick it looks every unfinished intent up at the broker, by order ID or by tag.
- **A timeout is never treated as a failure.** If sending times out or the network drops, the intent is marked *uncertain* and looked up by tag. It is never resent. It is marked *not found* only after three lookups spanning at least `orderTimeoutSeconds`.
- **One entry attempt per stock per day**, whatever happened to it, so a restart mid-evaluation can't buy twice.
- **Partial fills.** Fills are applied incrementally (filled quantity, remaining quantity, average price), and the stop is resized to cover exactly the shares held. A market order still unfinished after `orderTimeoutSeconds` has its remainder cancelled.
- **Stop protection counts only when the broker shows the stop as `TRIGGER PENDING`.** If a stop's state is uncertain or unknown, the engine looks it up and never places a second one. If a stop-loss modification fails, the confirmed stop is kept and the modification retried. If a stop triggers but its limit doesn't fill within `triggeredStopGraceSeconds`, the engine cancels it and sells at market. After three rejected stop placements in a day, it stops retrying, logs an error each tick, and sells itself if the price reaches the stop.
- **Exits.** The engine sells only after the broker confirms the stop is cancelled, so the stop and the sell can't both fill. Retries cover only the confirmed remaining shares.
- **Position reconciliation.** If the broker shows fewer shares than the engine expects, that must be seen on two consecutive polls, with no orders still resolving, before it's accepted. A failed lookup changes nothing. Extra shares at the broker are reported but never managed.
- Every Kite request has a timeout. Kite errors are classed as definite rejections or uncertain outcomes. Registered secrets and credential patterns are masked in logs.

### Kill switch

| Action | Effect |
|---|---|
| `touch STOP` (empty or `HALT`) | **No new entries.** The engine keeps running: positions stay managed, stops are re-placed each morning and trailed, and exits still happen. |
| `echo FLATTEN > STOP` | **Close everything.** Cancels in-flight entries, then for each position cancels the stop (waiting for the broker to confirm) and sells at market. Once flat, the engine exits. |
| `rm STOP` | Resume normal trading. |
| Ctrl+C / killing the process | Nothing is sent to the broker. Stops placed today stay live until the close, then **positions are unprotected until the engine is restarted.** |

The kill switch is checked at every tick and again before every new entry.

### Portfolio backtest vs NIFTY 50

```bash
npm run portfolio                                              # 2016-01-01 to today
npm run portfolio -- --from 2016-01-01 --to 2025-12-31 --split 2022-01-01 --trades
npm run portfolio -- --constituents data/nifty50_members.csv  # point-in-time universe (symbol,from,to)
npm run portfolio -- --benchmark-csv data/NIFTY50_TRI.csv --benchmark-type TRI
```

All stocks share one pool of capital (`backtest.initialCapital`, ₹5,00,000), with up to `maxOpenPositions` positions and every risk limit applied.

- **Execution:** a signal from day *t*'s close fills at day *t+1*'s open, plus slippage. Stops act intraday at the stop price, or at the open if the price gaps through. An entry that opens at or below its planned stop is skipped.
- **Simultaneous signals:** filled in alphabetical order, as a neutral tie-break.
- **Cash:** sale proceeds are usable from the next session. Positions open at the end are shown both marked to market and after selling costs.
- **Costs:** itemised Indian delivery charges from `backtest.costs`: STT, stamp duty, exchange and SEBI fees, GST, and DP charges. Check these against your broker's current rates.
- **Benchmark:** buy-and-hold of the NIFTY 50 with the same capital, calendar, costs and slippage.
  - The default is Yahoo `^NSEI`, a **price index** without dividends.
  - For the **Total Return Index**, download *NIFTY 50 TRI* history from niftyindices.com and pass it with `--benchmark-type TRI`.
- **Training and test periods:** results are shown for the full period, the training period and the test period (`--split`, default at 70% of the range). Tune parameters on the training period only.
- **Price cache:** prices are saved in `data/cache/yahoo/` for 24 hours (`--refresh` re-downloads).

**Biases that are not solved:**
- Without `--constituents`, the universe is today's large caps (**survivorship bias**, which flatters the strategy).
- The company-study filter isn't applied, because past fundamentals aren't available.
- Dividends on the strategy's holdings aren't credited.
- Capital-gains tax isn't deducted from either side.

`npm run backtest` (one stock at a time) uses the same execution rules.

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
- Paper fills are at the polled last price plus slippage. A stop is only seen as triggered if a poll catches the price at or below it, and a stop-limit fills only if the price is still above its limit. The paper broker can simulate partial fills (`fillRatio`), but real fills and queue priority will differ.
- Recovery from crashes relies on the broker reporting orders by tag. Kite's order list covers only the current day, so an order whose outcome is unknown at the close is resolved the next day through position reconciliation, with the fill price unknown.
- NSE holidays are not built in. Add them to `engine.holidays` (`"YYYY-MM-DD"`). Kite also rejects orders on holidays.
