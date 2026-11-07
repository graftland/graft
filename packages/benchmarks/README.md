# Graft benchmarks

A private benchmark workspace comparing Graft with cordis, avvio, raw Effect,
Node EventEmitter and emittery. Equivalent work is checked before interpreting
speed. Unsupported operations appear as N/A with a reason in the report.

## Run

Run every command from the repository root. Dependencies and the pnpm store stay
in this worktree. The benchmark command builds Graft and its adapters first.

```sh
devenv shell -- pnpm install --frozen-lockfile --store-dir .cache/pnpm-store
devenv shell -- pnpm bench
devenv shell -- pnpm --filter @graftland/benchmarks bench --quick
devenv shell -- pnpm bench --scenario fanout,events --implementation graft,cordis
devenv shell -- pnpm bench --scenario memory-cycles --cycles 1000 --output .cache/long-churn
```

| Option             | Behavior                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--quick`          | Keep the original size matrix; reduce samples. Remote footprint uses N=1. Smoke check only.                                                                |
| `--scenario`       | Comma-separated substrings of the scenario names below.                                                                                                    |
| `--implementation` | Comma-separated names: graft, cordis, avvio, effect, node, emittery; in-process, remote-local, remote-worker, remote-unix, remote-ws, raw-worker, raw-ipc. |
| `--cycles`         | Override the number of persistent-root load/unload cycles.                                                                                                 |
| `--output`         | Output stem relative to this package; defaults to results/latest or .cache/quick.                                                                          |

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
| replace                                           | Replace K distinct definitions in one transaction and await all replacement activations; K = 1, 10, 100.               |
| memory-cycles                                     | Heap growth after 100 cycles of 10 plugins in one persistent root, with checkpoint slopes.                             |
| memory-steady                                     | Heap delta for 1000 live plugins relative to an empty root, divided by plugin count.                                   |
| import                                            | Import each library in a fresh process; record import latency and child-process wall time separately.                  |

## Remote

`@graftland/plugin-remote` is measured against the same in-process service, with
direct `local`, direct `worker`, a Unix-socket runner, and a loopback `ws`
runner. Raw worker `postMessage` and child-process IPC supply echo baselines.
Runner servers are prepared before entry timing. Runner heap and CPU are a
combined host+runner substitute because the server is embedded in the host
process. This measures same-machine runner transport, not remote networks, TLS
or authentication.

```sh
devenv shell -- pnpm bench --scenario remote-
devenv shell -- pnpm bench --quick --scenario remote-r2,remote-r8
devenv shell -- pnpm bench --scenario remote-r4 --implementation remote-unix,remote-ws
```

| Scenario                         | Measurement                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| remote-r1-start / remote-r1-stop | Entry load to an injected consumer's successful first call; disposal to actual child/worker exit and consumer settlement.                                                                   |
| remote-r2-call                   | Tiny unary round trip, with mean/p50/p99/p999 and raw Node baselines.                                                                                                                       |
| remote-r3-throughput             | 256 completed calls at 1, 16 or 256 submitted in flight; compare one contract batch containing the same 256 operations.                                                                     |
| remote-r4-payload                | Echo 100 B, 10 KB, 1 MB, 1 MiB and 1 MiB+1 B ASCII request/response text. Rejected frames are separate outcomes.                                                                            |
| remote-r5-stream                 | Complete the supported contract stream, values 0..99.                                                                                                                                       |
| remote-r6-config                 | In-process update function versus a complete Remote restart, including old native exit and a usable new consumer.                                                                           |
| remote-r7-footprint              | Host retained heap/entry, child RSS/process, worker isolate heap and aggregate host RSS delta, at 1/10/50 entries. The same run also records time to start N entries sequentially.          |
| remote-r8-loop                   | Identical 50-million-step CPU loop; host delay histogram and timer-inclusive latency of an unrelated in-process service call.                                                               |
| remote-r9-logs                   | Zero-log control, 100 paced logs, 10000/100000-log bursts; host CPU, delivery/drop counts and warning frequency. Timing includes graceful drain and stop, an explicitly labeled substitute. |
| remote-r10-failure               | Acknowledged pre-exit notice to Failed and consumer stop; also native-exit-event to Failed. In-process host death is verified separately.                                                   |

Remote cases use fixed sample budgets: 20 lifecycle samples after 3 warmups;
5000 unary calls after 500 warmups; 30 hot batches after 3 warmups; 5
CPU/log/crash repetitions; 3 footprint and rejection repetitions. CPU has one
discarded loop. Quick mode reduces these to 2–10 samples and footprint size 1.
Its results are smoke checks. The old size matrix remains intact. Remote timing
uses native performance clocks and the same conservative 95% estimator as
import/memory measurements, retaining per-call tails and non-timing
observations. Persistent hot fixtures keep startup and disposal outside call
timing. Raw Node baselines include simpler serialization and scheduling;
subtracting them does not isolate framing alone. p999 from 5000 samples has only
about five upper-tail observations.

The data admission default is 16. Runner frames allow 1 MiB of protocol payload;
business data also needs envelope bytes. Direct connections use a different
path, so their limits are tested separately. Remote never updates in place.
Individual worker RSS is process-wide and therefore N/A; host RSS delta per
entry is an aggregate estimate. Log measurements use process.threadCpuUsage for
host-thread CPU and retain process.cpuUsage as a companion. Native default
loggers remain active and the executable mains route them to stderr. The stdout
guard counts unexpected output (zero bytes in this R9 run). Direct-worker stderr
is captured by the runner; local/runner stderr uses ProcessObservation's bounded
path. The structured host sink counts in memory; it is not a terminal or
production disk exporter. Structured counts and full failure causes remain
available.

Each case owns its scope, children and workers. Native identities and exit
events are checked, then the runner scans process environments for its unique
ownership token. Linux `/proc/self/fd` keeps Unix socket paths short while the
socket inode and state remain inside this worktree. Connection tests use a 300
ms runner lease to avoid waiting for the production renewal period; benchmarks
keep all Remote defaults. Tests cover call counts/results, concurrent payloads,
streams, updates, logs, CPU checksums, crash propagation and native exit at
small N.

[Remote guidance](results/remote-guidance.md) separates measured facts,
inference, and proposed edits to the best-practice guides.

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
check. Only latest.json, latest.md and remote-guidance.md belong in results/.

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
| replace            |  100 | ms       |  34.352 |    N/A |   N/A |     N/A |   N/A |      N/A |
| memory-cycles      |   10 | B/batch  |  31828* | 23860* |   N/A |   7649* |   N/A |      N/A |
| memory-steady      | 1000 | B/plugin |   33908 |  10264 |   821 |    2089 |   N/A |      N/A |
| import             |    1 | ms       | 242.159 |  4.409 | 6.126 | 230.756 | 0.173 |    1.988 |

| Scenario             |    Size | Unit    | in-process | remote-local | remote-worker | remote-unix | remote-ws | raw-worker | raw-ipc |
| -------------------- | ------: | ------- | ---------: | -----------: | ------------: | ----------: | --------: | ---------: | ------: |
| remote-r1-start      |       1 | ms      |     2.673* |      866.756 |       698.801 |    1462.665 |  1459.621 |        N/A |     N/A |
| remote-r1-stop       |       1 | ms      |     1.032* |       43.707 |       21.003* |      75.011 |    76.665 |        N/A |     N/A |
| remote-r2-call       |       1 | ms      |     0.007* |        0.626 |         0.568 |       1.195 |     1.346 |     0.028* |   0.051 |
| remote-r5-stream     |     100 | ms      |     0.038* |       3.077* |        3.366* |      6.536* |    5.278* |        N/A |     N/A |
| remote-r6-config     |       1 | ms      |     1.084* |      886.988 |       705.356 |    1509.301 |  1528.991 |        N/A |     N/A |
| remote-r8-loop       |       1 | ms      |     55.592 |      65.366* |        63.998 |      66.895 |    64.864 |        N/A |     N/A |
| remote-r10-failure   |       1 | ms      |        N/A |      33.348* |       14.718* |     65.278* |   58.348* |        N/A |     N/A |
| remote-r3-throughput |     256 | ms      |     2.000* |       61.159 |        57.755 |     168.286 |   184.851 |     1.405* |  1.698* |
| remote-r3-batch      |     256 | ms      |     0.430* |       3.408* |        3.271* |      4.953* |    5.230* |     0.240* |  0.336* |
| remote-r4-payload    | 1048577 | ms      |     0.021* |       9.842* |        8.187* |    rejected |  rejected |     1.306* |  4.960* |
| remote-r7-footprint  |      50 | B/entry |     89574* |      551195* |       506719* |    1260698* |  1263234* |        N/A |     N/A |
| remote-r9-logs       |  100000 | ms      |    63.792* |    1045.619* |      676.101* |   1051.592* |   985.239 |        N/A |     N/A |

<!-- results:end -->

## Semantic limits

| Library         | Comparison boundary                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graft           | Wait for Active, not registration. Config scenarios decode Schema.Int; event invocations restore context and own scopes.                                                                            |
| cordis          | Pinned 4.0.0-rc.12; await inertia and assert state. Serial can bail; emit/bail are synchronous. This version has no registry.replace.                                                               |
| avvio           | Ordered boot and close hooks. Runtime unload, restart and replacement are N/A. Whole-loader close and manually wired services are labeled substitutes. events-emit uses its inherited EventEmitter. |
| Effect          | Explicit Layer/Scope wiring and dependent teardown/rebuild; PubSub for parallel broadcasts, manual loops for other modes. No automatic reactive graph is claimed.                                   |
| Node / emittery | Dispatch only. Node emit completes synchronous bodies; emittery defers listeners and awaits them. Neither supplies bail or middleware.                                                              |

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
