# Bursa MusangKing Strategy Terminal

A **new standalone phone-first browser/PWA** for market-wide ATR signal tracking across the full Bursa Malaysia universe. It does not modify or replace the existing BursaMusangKing production app.

## Strategies tracked

- Trending + ATR (`trending`)
- Momentum + ATR (`gaining_momentum`)
- M.E.T.A. + ATR (`meta_leader`)

The publisher clones `yankhaing-cmyk/BursaMusangKing` read-only at runtime and calls its current strategy checks directly. Entry rules are therefore not copied into this project.

## Exact ATR semantics

The state engine mirrors the current `BursaMusangKing_App/export_backtest.py` ATR behavior:

- strategy signal occurs on the signal bar;
- theoretical entry is the **next trading session open**;
- initial stop uses upstream `BACKTEST.stop_loss_pct`;
- each session checks **low <= existing stop before updating the peak**;
- peak is the highest **close**, not intraday high;
- trailing stop only ratchets upward: `max(old_stop, highest_close - 3 × ATR14)`;
- exit is assumed at the stop price;
- commission is deducted on both entry and exit;
- no re-entry is evaluated on the exit day.

## Why bootstrap is mandatory

Starting with an empty database would misclassify stocks already inside an ATR trade. The manual bootstrap workflow replays historical data using the upstream entry checks and the same ATR mechanics, then seeds the current state for all three strategies. Daily publishing is rejected until bootstrap succeeds.

Bootstrap visible performance intentionally starts from bootstrap day; historical replay is used to establish current state, not presented as forward-live performance.

## Fail-closed reliability controls

- Full-market data must have at least `MIN_UNIVERSE=900` current-date valid symbols.
- Stale symbols whose last bar is older than the latest Bursa date are excluded before publish.
- If current-date coverage drops below 900, **nothing is published and no BUY/SELL state changes occur**.
- All 1,000+ rows are schema-validated in the Worker.
- Duplicate symbols are rejected.
- All three strategy hit flags must exist for every row.
- Historical bootstrap is mandatory before daily updates.
- Same-date daily payloads cannot silently overwrite a different already-accepted payload.
- Daily publisher verifies `/api/health` after every publish.
- Strategy state is stored persistently and survives scanner-result changes.

## Cloudflare Free-plan-safe D1 design

The app does **not** write 3,000 individual D1 rows per nightly run. Instead it stores:

- one compact JSON state snapshot for Trending;
- one compact JSON state snapshot for Momentum;
- one compact JSON state snapshot for M.E.T.A.;
- one daily run record containing that day's events/trades.

This keeps D1 queries per Worker invocation very low while retaining all ~1,000+ stocks × three independent strategy states.

## Main screens

- **Today** — new BUY, SELL, NEAR SELL, confluence and unread signals across Bursa.
- **Open** — every current pending/open ATR strategy position across the market.
- **History** — daily signal history, filterable by ticker/strategy.
- **Performance** — forward-live closed trades, win rate, average return and profit factor by strategy.
- **Health** — latest full-market trade date, coverage, active states and bootstrap status.

## First deployment order

1. Create a **new** D1 database: `bursa-musangking-strategy-terminal`.
2. Put the new database ID in `wrangler.jsonc`.
3. Deploy this Worker under a **new** Worker name/URL.
4. Set a new `PUBLISH_TOKEN` secret.
5. Apply `migrations/0001_init.sql`.
6. Add GitHub Actions secrets `WORKER_URL` and `PUBLISH_TOKEN` for this new Worker.
7. Manually run **Bootstrap Bursa ATR Strategy State** once.
8. Confirm `/api/health`: `bootstrapped=true`, total states >= 2700, correct Bursa trade date.
9. Run **Bursa ATR Strategy Scan** manually once on the next trading session.
10. Confirm Health remains OK with >=900 current-date rows before relying on signals.

The scheduled scan is weekdays at 8:10 PM Malaysia time.

## Verification

Local/core checks:

```bash
npm test
node --check src/index.js
node --check src/engine.js
node --check public/app.js
node --check public/sw.js
python -m py_compile python/*.py
```

GitHub CI repeats syntax, unit tests, 1,100-stock state simulation, bootstrap parity, and a SQLite migration smoke test.

A production acceptance test is only complete after a real full-market bootstrap and next-session publish both verify against the new Worker Health endpoint.
