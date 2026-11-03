# Market feed

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

A BTC-USD monitoring pipeline that survives a flaky exchange. `exchange`
publishes `Quotes`. `candles` turns them into one-minute bars and publishes
`Candles`. `alerts` reports bars that close at least 1% above their open. It
sends them through a Slack webhook when one is loaded.

```text
exchange --Quotes--> candles --Candles--> alerts
notifier -------------------Notifier----> alerts (optional)
```

The exchange is scripted. Its connection drops after the first bar, the next
connection attempt is refused, and the one after that succeeds. You need no
network and no credentials.

## The problem

When an upstream connection drops, every stage behind it is affected. If you
build this by hand, you need:

- a reconnect loop with backoff in the client;
- a way to tell the aggregator and the alerter that their input is gone;
- code in each of them to wait for the input to come back and subscribe again;
- care that a failure in a background reader is not silently lost.

Adding or removing an optional integration, such as a webhook, also needs its
own reconfiguration path.

## What Graft does instead

The business plugins only describe what they do while their inputs exist:

- **Consumers wait for their providers.** `candles` and `alerts` are loaded
  before the exchange and stay `Pending`, with the keys they are missing.
  Publishing `Quotes` starts the whole chain.
- **Background failures are supervised.** The exchange's read loop runs with
  `Plugin.fork`. When the socket drops, Graft logs the full cause and withdraws
  `Quotes`. It stops `alerts`, then `candles`, then closes the connection, and
  marks `exchange` as `Failed`. The consumers go back to `Pending`.
- **Retry is a schedule.** `retry: Schedule.exponential("400 millis")` tries a
  fresh activation after 400 ms (refused) and again after 800 ms (accepted). The
  same forks become `Active` again. Neither consumer has a reconnect loop or a
  check for a missing service.
- **Optional dependencies restart only their consumer.** `alerts` declares
  `Plugin.optional(Notifier)`. Loading or unloading the notifier restarts
  `alerts` alone, which switches between webhook delivery and log-only delivery.
  The exchange connection and the bar in progress are not touched.
- **The state is observable.** The run prints `Graft.forks` snapshots as the
  pipeline moves between `Pending`, `Active`, and `Failed`.

Graft recovers the pipeline, not the data. Quotes sent during an outage are not
replayed, and the bar in progress when the feed drops is discarded. Backfill and
durable delivery are separate concerns.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-market-feed start
```

What to look for in the output:

- Step 1: both consumers `Pending`, each with the service it waits for.
- Step 3: `The plugin's background task failed` with the `ExchangeUnavailable`
  cause, then `alerts: stopped`, `candles: stopped`, `exchange: stopped`, in
  that order. Then `connecting (attempt 2)` about 400 ms later, refused.
- Step 4: `connecting (attempt 3)` about 800 ms after that, and all three forks
  `Active` with their original IDs.
- Steps 5 and 6: only `alerts` stops and starts when the notifier comes and
  goes.

`devenv shell -- pnpm --filter @graftland/sample-market-feed test` checks each
of these claims. It uses `TestClock` for the retry delays.

## Files

| File                       | What it is                                                 |
| -------------------------- | ---------------------------------------------------------- |
| `src/services.ts`          | Quote and candle types, service keys, the transport error. |
| `src/exchange.ts`          | Connects, runs the supervised reader, publishes `Quotes`.  |
| `src/candles.ts`           | One-minute bars; publishes `Candles`.                      |
| `src/alerts.ts`            | The 1% rule and optional webhook delivery.                 |
| `src/notifier.ts`          | A simulated Slack webhook.                                 |
| `src/scripted-exchange.ts` | The scripted exchange used by the run and the tests.       |
| `src/observe.ts`           | Waiting for states and log lines; fork tree snapshots.     |
| `src/main.ts`              | The scripted run.                                          |
| `test/market-feed.test.ts` | Tests for the behavior above.                              |
