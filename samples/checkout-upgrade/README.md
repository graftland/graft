# Checkout upgrade

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

An order worker drains a queue while the pricing engine is upgraded and the
database fails over to a new host. No order is lost, no order is processed
twice, and no query ever reaches a closed connection pool.

## The problem

Swapping a dependency inside a running service is where shutdown bugs live. To
replace the pricing engine or move to a new database host without a restart, you
normally have to:

- stop taking new work, but finish the order that is already in progress;
- stop everything that uses the old engine or pool, in the right order, before
  you close it;
- start the new one, then restart its users against it;
- keep the queue and the stored data intact through all of this.

Most services give up and restart the process, which drops work in flight. Or
they write a custom drain-and-swap routine for each dependency.

## What Graft does instead

The plugins are written as if nothing ever changes. `checkout` reads `Database`
and `Pricing` once in `apply`. `order-worker` reads `Checkout` once. Graft
handles the change:

- **`Graft.replace([[pricingV1, pricingV2]])`** restarts every fork of the old
  engine with the new one. Before `Pricing v1 unloaded`, Graft stops the worker
  and then `checkout`, because they use what v1 published. Then it starts v2,
  `checkout`, and the worker, in dependency order. TypeScript checks that v2
  accepts the same input as v1.
- **`fork.update({ url })`** on the database restarts it with the new host, in
  the same order. The worker finishes the order it took, `checkout` stops, then
  the old pool closes and the new one opens.
- **Stopping waits for work in flight.** The worker processes each order
  uninterruptibly. Graft stops `Plugin.fork` tasks and waits for them before it
  withdraws any service they use.
- **What outlives plugins lives in the environment.** The order queue and the
  database's storage are given to `Graft.layer`, so they survive every restart.
  Orders that arrive during a swap wait in the queue.

The database plugin turns a query on a closed pool into a defect. So if the stop
order were ever wrong, the worker would fail and the run would show an error.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-checkout-upgrade start
```

What to look for in the output:

- Step 2: `Order worker stopped`, `Checkout down`, `Pricing v1 unloaded`, then
  the same three coming back up with v2. Orders after that are priced by v2: the
  three-item cart drops from $52 to $46.8.
- Step 3: the order in flight finishes on `db-1` _before_ `Order worker stopped`
  and `Closed pool to postgres://db-1...`.
- Step 4: `24 orders placed, 24 receipts, 24 distinct orders`.

`devenv shell -- pnpm --filter @graftland/sample-checkout-upgrade test` checks
each of these claims.

## Files

| File                            | What it is                                                         |
| ------------------------------- | ------------------------------------------------------------------ |
| `src/Orders.ts`                 | The order queue and the database storage, both in the environment. |
| `src/Checkout.ts`               | The `Database`, `Pricing` and `Checkout` service keys.             |
| `src/plugins/database.ts`       | Opens a connection pool and publishes `Database`.                  |
| `src/plugins/pricing.ts`        | Pricing engines v1 and v2.                                         |
| `src/plugins/checkout.ts`       | Quotes and stores an order; publishes `Checkout`.                  |
| `src/plugins/worker.ts`         | Takes orders off the queue, one at a time.                         |
| `src/main.ts`                   | The scripted run.                                                  |
| `test/checkout-upgrade.test.ts` | Tests for the behavior above.                                      |
