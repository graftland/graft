# Graft benchmarks

A private benchmark workspace comparing Graft with cordis, avvio, raw Effect,
Node EventEmitter and emittery. Equivalent work is checked before interpreting
speed. Unsupported operations appear as N/A with a reason in the report.

## Run

Run every command from the repository root. Dependencies and the pnpm store stay
in this worktree. The benchmark command builds Graft and its adapters first.

CI runs the quick suite on pushes to `main` and on pull requests that touch
`packages/`, and the full suite weekly or from the Benchmarks workflow's **Run
workflow** button. Each run puts its report in the job summary and its JSON in
an artifact. CI runners are shared, so CI reports numbers without failing on
them; compare runs only with each other.

```sh
devenv shell -- pnpm install --frozen-lockfile --store-dir .cache/pnpm-store
devenv shell -- pnpm bench
devenv shell -- pnpm --filter @graftland/benchmarks bench --quick
devenv shell -- pnpm bench --scenario fanout,events --implementation graft,cordis
devenv shell -- pnpm bench --scenario memory-cycles --cycles 1000 --output .cache/long-churn
```

| Option       | Behavior                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------- |
| `--quick`    | Keep the original size matrix; reduce samples. Remote footprint uses N=1. Smoke check only. |
| `--scenario` | Comma-separated substrings of the scenario names below.                                     |
| `--cycles`   | Override the number of persistent-root load/unload cycles.                                  |
| `--output`   | Output stem relative to this package; defaults to results/latest or .cache/quick.           |

JSON and Markdown are saved after each completed case. Errors remain in both
outputs and make the command fail. CI runs equivalence tests and a small runner
smoke check through root `pnpm test`. It does not run the full performance suite
or enforce speed thresholds.

## Scenarios

| Scenario                                          | Work per sample                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| cold-load / cold-dispose                          | Activate / dispose N independent plugins; N = 1, 100, 1000. Empty-root construction is outside timing.                 |
| fanout-load / fanout-withdraw / fanout-restore    | One provider and N consumers; load until active, withdraw until stopped, restore until active again. N = 1, 100, 1000. |
| chain                                             | D plugins read their predecessor service; D = 1, 10, 100, registered in topological order.                             |
| service                                           | 10000 service lookups and synchronous method calls from a dependent; check the checksum.                               |
| events-emit / events-sequential / events-parallel | 100 completed broadcasts to H = 1, 10, 100 handlers. Handler bodies are synchronous.                                   |
| events-bail / events-serial-bail                  | 100 dispatches; handler H returns 7 after the previous handlers decline.                                               |
| events-waterfall                                  | 100 middleware dispatches; each wrapper adds one to the terminal result 0.                                             |
| config-update / config-restart                    | Change value 0 to 1 in place / by teardown and reactivation.                                                           |
| memory-cycles                                     | Heap growth after 100 cycles of 10 plugins in one persistent root, with checkpoint slopes.                             |
| memory-steady                                     | Heap delta for 1000 live plugins relative to an empty root, divided by plugin count.                                   |
| import                                            | Import each library in a fresh process; record import latency and child-process wall time separately.                  |

## Methodology

| Setting                                    | Full run                                             | Quick run   |
| ------------------------------------------ | ---------------------------------------------------- | ----------- |
| Timed samples                              | At least 100 and 2000 ms of measured work            | 3           |
| Warmup                                     | At least 20 iterations and 1000 ms                   | 1 iteration |
| Service calls / event dispatches per batch | 10000 / 100                                          | 100 / 2     |
| Heap repetitions / churn cycles            | 20 / 100                                             | 3 / 5       |
| Fresh imports / discarded startup samples  | 400 / 3                                              | 3 / 1       |
| GC                                         | `--expose-gc`, three GC requests per heap checkpoint | Same        |

Tinybench 6.2.3 supplies awaited iteration hooks and retained timing samples
without transitive dependencies. statistics.mjs combines every batch using
conservative Student-t margins and interpolated quantiles. Each scenario, size
and implementation gets its own sequential Node worker. Timing samples within
that worker share JIT state; every import sample gets a fresh process. Each
timed operation includes the same Effect.runPromise bridge. Setup, audit
comparisons and cleanup are outside timing, except when disposal itself is
measured.

The report gives mean, p50, p99, ops/s, relative 95% margin of error and the
ratio of Graft mean to competitor mean. Ops/s counts individual service calls or
dispatches in hot batches. Rows above 5% RME remain marked noisy; there is no
outlier removal. Heap deltas keep negative GC noise and have no speed ratio. CPU
affinity, frequency, filesystem caches and unrelated machine load are
uncontrolled. Checkpoint growth alone does not prove a leak.

Original timing cases continue within the same worker in 2-second batches until
combined RME is at most 4%, 24 seconds of measured work, or 480 seconds of
worker wall time. Every sample is retained. The nominal 95% interval is
descriptive under this repeated stopping rule; it is not a sequential confidence
guarantee. Capped rows remain marked noisy. Warmup occurs once; later batches
retain JIT state. Remote fixed budgets are unchanged.

## Results

The canonical full run contains 295 measurements and 136 N/A cells, with no
failures. All 154 original-library timing rows are below 5% RME. Runner wall
time is 4772.3 s; the audit verified 3164 native exits and zero leftovers. 98
Remote rows and three signed-heap rows remain above 5% RME.

At H=100, the canonical 100-dispatch batch takes 52.85 ms in Graft and 2.63 ms
in cordis: 5.29 µs and 0.263 µs per handler invocation, or 20.1×.

[Full report](results/latest.md) contains every size, comparison ratio, N/A
reason and semantic interpretation. [JSON](results/latest.json) records
environment, exact versions, code hash, sample counts, batch history and
native-exit audit. Lossless raw samples are linked under ignored
`.cache/samples/`. Quick output defaults to `.cache/quick.*` and is a smoke

Refresh all three result tables from the canonical full run:

```sh
devenv shell -- node packages/benchmarks/update-readmes.mjs results/latest.json
devenv shell -- treefmt
```

The tables select the largest size per scenario. Means are per batch;
memory-steady uses bytes/plugin. `*` marks RME above 5% or undefined. Scenario
and column labels stay identical across languages.

<!-- results:start -->

| Scenario           | Size | Unit     |   Graft | cordis | avvio |  Effect |  Node | emittery |
| ------------------ | ---: | -------- | ------: | -----: | ----: | ------: | ----: | -------: |
| cold-load          | 1000 | ms       | 212.037 | 86.267 | 6.512 |   3.617 |   N/A |      N/A |
| cold-dispose       | 1000 | ms       | 129.024 | 36.605 | 0.175 |   1.230 |   N/A |      N/A |
| fanout-load        | 1000 | ms       | 229.280 | 98.477 | 6.568 |  10.931 |   N/A |      N/A |
| fanout-withdraw    | 1000 | ms       | 154.158 | 43.024 |   N/A |   2.737 |   N/A |      N/A |
| fanout-restore     | 1000 | ms       | 185.885 | 61.085 |   N/A |  11.549 |   N/A |      N/A |
| chain              |  100 | ms       |  45.806 | 25.256 | 0.695 |   1.330 |   N/A |      N/A |
| service            |    1 | ms       |   1.735 | 54.431 | 0.093 |   1.585 |   N/A |      N/A |
| events-emit        |  100 | ms       |  52.854 |  2.632 | 0.067 |   1.306 | 0.067 |    0.777 |
| events-sequential  |  100 | ms       |  54.776 |  3.719 |   N/A |   1.559 |   N/A |    0.770 |
| events-parallel    |  100 | ms       |  78.686 |  5.008 |   N/A |  16.697 |   N/A |    2.143 |
| events-bail        |  100 | ms       |  52.720 |  2.593 |   N/A |   1.472 |   N/A |      N/A |
| events-serial-bail |  100 | ms       |  53.139 |  3.497 |   N/A |   1.387 |   N/A |      N/A |
| events-waterfall   |  100 | ms       |  95.097 | 11.016 |   N/A |  12.778 |   N/A |      N/A |
| config-update      |    1 | ms       |   0.120 |  0.040 |   N/A |   0.002 |   N/A |      N/A |
| config-restart     |    1 | ms       |   0.237 |  0.109 |   N/A |   0.006 |   N/A |      N/A |
| memory-cycles      |   10 | B/batch  |  31828* | 23860* |   N/A |   7649* |   N/A |      N/A |
| memory-steady      | 1000 | B/plugin |   33908 |  10264 |   821 |    2089 |   N/A |      N/A |
| import             |    1 | ms       | 242.159 |  4.409 | 6.126 | 230.756 | 0.173 |    1.988 |

<!-- results:end -->

## Semantic limits

| Library         | Comparison boundary                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graft           | Wait for Active, not registration. Config scenarios decode Schema.Int; event invocations restore context and own scopes.                                                               |
| cordis          | Pinned 4.0.0-rc.12; await inertia and assert state. Serial can bail; emit/bail are synchronous.                                                                                        |
| avvio           | Ordered boot and close hooks. Runtime unload and restart are N/A. Whole-loader close and manually wired services are labeled substitutes. events-emit uses its inherited EventEmitter. |
| Effect          | Explicit Layer/Scope wiring and dependent teardown/rebuild; PubSub for parallel broadcasts, manual loops for other modes. No automatic reactive graph is claimed.                      |
| Node / emittery | Dispatch only. Node emit completes synchronous bodies; emittery defers listeners and awaits them. Neither supplies bail or middleware.                                                 |

Config comparison uses Graft validation and no optional cordis schema. Waterfall
compares output wrapping only: the libraries differ in next-input and repeated
next behavior. All handler bodies are synchronous, so the event tables do not
measure asynchronous I/O throughput. The per-scenario report labels substitutes
and gives testable alternatives to any performance explanation.

## Sources and checks

The root test command and worker pool are unchanged. Remote connection witnesses
run sequentially in one coordinator, with independent roots and verified native
exits. Runner ownership audits and the short Unix-path adapter currently target
Linux.

Root `devenv.nix` excludes large generated result JSON from formatting. Source
files and Markdown remain formatted.

[SOURCES.md](SOURCES.md) lists source paths, line numbers, constants, completion
barriers and N/A evidence. [Equivalence tests](test/equivalence.test.ts) check
activation/finalizer/handler/service-call counts, config updates and results,
both before and after cleanup, including repeated unload cycles.
[Runner tests](test/runner.test.ts) check process imports and inert module entry
points. Implementation checks and performance interpretations are separate.

```sh
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm build
devenv shell -- treefmt
```

Root changes register bench/typecheck and exclude generated result JSON from
formatting. Existing package, test-matrix and release discovery already handle
this private package. No core, loader or other existing package source is
changed.

Profile only the measured operation; root setup, observer assertions and
disposal are excluded. Raw CPU profiles stay in the ignored cache. Sampling
perturbs timing; profiles explain execution paths rather than replace benchmark
estimates.

```sh
devenv shell -- node packages/benchmarks/profile.mjs --scenario events-emit --implementation graft --size 100 --calls 100
devenv shell -- node packages/benchmarks/profile.mjs --scenario cold-load --implementation cordis --size 1000 --calls 1
```
