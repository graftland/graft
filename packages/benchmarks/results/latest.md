# Graft benchmark results

Mode: **full**. Wall time: **4772.3 s**. Generated: 2026-11-07T11:21:19.079Z.

Node v26.12.1; AMD EPYC-Genoa Processor; linux 6.18.56; x64.

Git: c5055a7f237e3900b4ae6348ce1bc92145f644a4 (dirty: true); suite SHA-256:
141a2cb8544c0e67ed7af230cea92a41868826a0364d70116da079466c582acd.

Versions: @graftland/graft 0.0.0, @graftland/plugin-remote 0.0.0,
@effect/platform-node 4.1.2, @graftland/loader 0.0.0, ws 8.22.1, pkijs 4.0.1,
asn1js 4.0.0, effect 4.1.2, cordis 4.0.0-rc.12, avvio 9.3.1, emittery 2.2.0,
tinybench 6.2.3.

Timing mean/p50/p99 are milliseconds per batch. Ops/s uses individual service
calls or dispatches for hot batches, and complete scenario operations otherwise.
Ratio = Graft mean / competitor mean; above 1 means Graft takes longer. Remote
uses the in-process reference. Ratios compare means, not causality. Memory
ratios are omitted because signed heap deltas can cross zero.

Remote tables also show p999. Startup includes the first consumer call; hot
Remote calls reuse a live fixture. Runner setup is outside entry startup. R7
includes startup timing as a second observation of the same isolated memory
scenario. Native stdout formatting is retained and drained into a counted
in-memory sink; the host structured logger counts without console or disk I/O.

RME is the relative 95% margin of error. Rows above 5% are marked **noisy**;
quick mode is a smoke check. Percentiles describe samples in this run, not
production tail latency. Repeated iterations share one worker per case; imports
alone get a new process per sample. No claim of process-level statistical
independence is made.

Source decisions, constants, completion barriers and semantic limits:
[SOURCES.md](../SOURCES.md). Raw sample-file references, heap checkpoints,
errors and environment details: [JSON](latest.json).

Original timing rows start with at least 100 samples and 2 seconds measured time
after at least 20 warmups and 1 second warmup time. Continue in the same worker
in 2-second batches to 4% RME, 24 seconds measured time or 480 seconds worker
wall. Retain every sample and capped result. Repeated precision checks make the
nominal 95% interval descriptive, not a sequentially valid confidence guarantee.
Remote fixed budgets are unchanged.

## cold-load

Independent plugin activation, excluding root construction and definition
imports. Graft supervises scopes and transactions; cordis uses context proxies;
avvio orders a boot queue; raw Effect builds one scoped Layer per resource. An
allocation profile or an equal scheduling policy could change attribution.

| Size | Implementation |    Mean |     p50 |     p99 |    p999 |  Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | ------: | ------: | ------: | ------: | -----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |   0.340 |   0.253 |   2.975 |  10.871 |   2945 | 3.7% |                — | ok                                                                                              |
|    1 | cordis         |   0.124 |   0.093 |   0.208 |   9.057 |   8078 | 3.9% |            2.74× | ok                                                                                              |
|    1 | avvio          |   0.012 |   0.008 |   0.027 |   0.090 |  80522 | 3.8% |            27.3× | ok                                                                                              |
|    1 | effect         |   0.009 |   0.006 |   0.020 |   0.042 | 113166 | 3.5% |            38.4× | ok                                                                                              |
|    1 | node           |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | graft          |  22.158 |  20.338 |  38.124 |  38.946 |     45 | 3.4% |                — | ok                                                                                              |
|  100 | cordis         |   8.384 |   7.017 |  19.487 |  26.301 |    119 | 3.6% |            2.64× | ok                                                                                              |
|  100 | avvio          |   0.645 |   0.403 |   6.513 |  12.620 |   1551 | 3.9% |            34.4× | ok                                                                                              |
|  100 | effect         |   0.401 |   0.308 |   1.673 |   8.854 |   2494 | 2.7% |            55.3× | ok                                                                                              |
|  100 | node           |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | graft          | 212.037 | 210.190 | 263.403 | 290.035 |      5 | 1.9% |                — | ok                                                                                              |
| 1000 | cordis         |  86.267 |  86.582 | 108.300 | 110.374 |     12 | 2.1% |            2.46× | ok                                                                                              |
| 1000 | avvio          |   6.512 |   4.568 |  19.606 |  25.315 |    154 | 3.7% |            32.6× | ok                                                                                              |
| 1000 | effect         |   3.617 |   3.013 |  11.040 |  13.208 |    277 | 3.6% |            58.6× | ok                                                                                              |
| 1000 | node           |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | emittery       |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## cold-dispose

Dispose the already active plugins, awaiting every finalizer. Avvio closes the
whole loader (substitute: no individual runtime unload). Graft retains
dependency and failure guarantees even without dependencies here. Reverse-order
or parallel cleanup policy and allocation profiles could explain gaps.

| Size | Implementation |    Mean |     p50 |     p99 |    p999 |  Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | ------: | ------: | ------: | ------: | -----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |   0.106 |   0.087 |   0.189 |   3.139 |   9460 | 2.9% |                — | ok                                                                                              |
|    1 | cordis         |   0.048 |   0.034 |   0.079 |   5.753 |  21017 | 3.5% |            2.22× | ok                                                                                              |
|    1 | avvio          |   0.004 |   0.002 |   0.007 |   0.022 | 267727 | 3.5% |            28.3× | ok                                                                                              |
|    1 | effect         |   0.002 |   0.002 |   0.004 |   0.019 | 417383 | 3.8% |            44.1× | ok                                                                                              |
|    1 | node           |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | graft          |  10.259 |   8.648 |  21.412 |  24.195 |     97 | 3.8% |                — | ok                                                                                              |
|  100 | cordis         |   3.593 |   3.005 |  13.687 |  16.432 |    278 | 3.5% |            2.85× | ok                                                                                              |
|  100 | avvio          |   0.017 |   0.011 |   0.042 |   0.077 |  59649 | 3.7% |             612× | ok                                                                                              |
|  100 | effect         |   0.094 |   0.074 |   0.191 |   7.706 |  10589 | 3.1% |             109× | ok                                                                                              |
|  100 | node           |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | graft          | 129.024 | 127.415 | 159.065 | 161.711 |      8 | 1.8% |                — | ok                                                                                              |
| 1000 | cordis         |  36.605 |  34.159 |  58.379 |  75.810 |     27 | 3.8% |            3.52× | ok                                                                                              |
| 1000 | avvio          |   0.175 |   0.123 |   0.437 |   8.606 |   5725 | 3.4% |             739× | ok                                                                                              |
| 1000 | effect         |   1.230 |   0.936 |   6.724 |  10.139 |    813 | 4.0% |             105× | ok                                                                                              |
| 1000 | node           |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | emittery       |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## fanout-load

Load one provider and N consumers, each calling the provider once. Avvio uses
ordered registration and a typed application property (manual wiring, no
reactive dependency graph). Raw Effect wires a Context manually. Profiles with
equivalent graph validation could change overhead attribution.

| Size | Implementation |    Mean |     p50 |     p99 |    p999 | Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | ------: | ------: | ------: | ------: | ----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |   0.672 |   0.514 |   3.470 |  12.044 |  1488 | 3.6% |                — | ok                                                                                              |
|    1 | cordis         |   0.328 |   0.248 |   0.571 |  10.351 |  3049 | 3.5% |            2.05× | ok                                                                                              |
|    1 | avvio          |   0.018 |   0.011 |   0.033 |   0.250 | 55827 | 3.9% |            37.5× | ok                                                                                              |
|    1 | effect         |   0.019 |   0.014 |   0.032 |   0.222 | 52508 | 3.6% |            35.3× | ok                                                                                              |
|    1 | node           |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | graft          |  21.449 |  19.311 |  39.215 |  44.487 |    47 | 3.7% |                — | ok                                                                                              |
|  100 | cordis         |  10.058 |   8.473 |  22.171 |  22.898 |    99 | 3.5% |            2.13× | ok                                                                                              |
|  100 | avvio          |   0.674 |   0.429 |   6.349 |  12.436 |  1484 | 3.8% |            31.8× | ok                                                                                              |
|  100 | effect         |   0.984 |   0.755 |   7.051 |  12.469 |  1016 | 3.5% |            21.8× | ok                                                                                              |
|  100 | node           |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | graft          | 229.280 | 224.450 | 289.853 | 301.830 |     4 | 1.8% |                — | ok                                                                                              |
| 1000 | cordis         |  98.477 |  97.785 | 122.938 | 126.363 |    10 | 1.4% |            2.33× | ok                                                                                              |
| 1000 | avvio          |   6.568 |   4.498 |  18.709 |  24.037 |   152 | 3.7% |            34.9× | ok                                                                                              |
| 1000 | effect         |  10.931 |  10.548 |  22.708 |  25.462 |    91 | 3.8% |            21.0× | ok                                                                                              |
| 1000 | node           |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | emittery       |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## fanout-withdraw

Withdraw one provider and wait for all N consumer finalizers and Pending states.
Raw Effect explicitly closes consumer scopes first (manual orchestration
substitute). Graft leases and cordis dependency tracking add work; profiling
dependency scans versus transactions could change the explanation.

| Size | Implementation |    Mean |     p50 |     p99 |    p999 |  Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | ------: | ------: | ------: | ------: | -----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |   0.290 |   0.234 |   0.698 |  10.343 |   3453 | 3.1% |                — | ok                                                                                              |
|    1 | cordis         |   0.139 |   0.099 |   0.229 |  10.198 |   7198 | 3.6% |            2.08× | ok                                                                                              |
|    1 | avvio          |       — |       — |       — |       — |      — |    — |                — | N/A: No runtime plugin unload or dependency reactivation API.                                   |
|    1 | effect         |   0.006 |   0.004 |   0.013 |   0.031 | 181016 | 4.0% |            52.4× | ok                                                                                              |
|    1 | node           |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | graft          |  14.802 |  13.446 |  28.546 |  38.811 |     68 | 3.4% |                — | ok                                                                                              |
|  100 | cordis         |   4.018 |   3.399 |  15.290 |  17.621 |    249 | 3.3% |            3.68× | ok                                                                                              |
|  100 | avvio          |       — |       — |       — |       — |      — |    — |                — | N/A: No runtime plugin unload or dependency reactivation API.                                   |
|  100 | effect         |   0.148 |   0.111 |   0.345 |   9.958 |   6747 | 3.3% |            99.9× | ok                                                                                              |
|  100 | node           |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | graft          | 154.158 | 152.250 | 187.856 | 196.776 |      6 | 1.9% |                — | ok                                                                                              |
| 1000 | cordis         |  43.024 |  41.746 |  53.950 |  55.271 |     23 | 2.8% |            3.58× | ok                                                                                              |
| 1000 | avvio          |       — |       — |       — |       — |      — |    — |                — | N/A: No runtime plugin unload or dependency reactivation API.                                   |
| 1000 | effect         |   2.737 |   1.982 |  12.592 |  17.802 |    365 | 3.6% |            56.3× | ok                                                                                              |
| 1000 | node           |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | emittery       |       — |       — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## fanout-restore

Restore the provider and wait for N consumer activations and calls. Raw Effect
explicitly rebuilds the consumer layers (manual orchestration substitute). Fresh
activation scopes, graph notification and Graft transactions may explain gaps; a
trace separating graph work from scheduling would change that inference.

| Size | Implementation |    Mean |     p50 |     p99 |    p999 | Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | ------: | ------: | ------: | ------: | ----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |   0.497 |   0.383 |   2.817 |  11.284 |  2012 | 3.8% |                — | ok                                                                                              |
|    1 | cordis         |   0.225 |   0.175 |   0.364 |  10.439 |  4436 | 3.5% |            2.20× | ok                                                                                              |
|    1 | avvio          |       — |       — |       — |       — |     — |    — |                — | N/A: No runtime plugin unload or dependency reactivation API.                                   |
|    1 | effect         |   0.016 |   0.012 |   0.035 |   0.212 | 61982 | 3.6% |            30.8× | ok                                                                                              |
|    1 | node           |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | graft          |  14.493 |  12.907 |  28.139 |  34.914 |    69 | 3.6% |                — | ok                                                                                              |
|  100 | cordis         |   5.832 |   4.874 |  16.400 |  19.453 |   171 | 3.6% |            2.48× | ok                                                                                              |
|  100 | avvio          |       — |       — |       — |       — |     — |    — |                — | N/A: No runtime plugin unload or dependency reactivation API.                                   |
|  100 | effect         |   0.980 |   0.753 |   9.122 |  11.655 |  1020 | 3.5% |            14.8× | ok                                                                                              |
|  100 | node           |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | graft          | 185.885 | 183.431 | 228.373 | 256.500 |     5 | 1.8% |                — | ok                                                                                              |
| 1000 | cordis         |  61.085 |  62.119 |  76.096 |  89.160 |    16 | 2.3% |            3.04× | ok                                                                                              |
| 1000 | avvio          |       — |       — |       — |       — |     — |    — |                — | N/A: No runtime plugin unload or dependency reactivation API.                                   |
| 1000 | effect         |  11.549 |  11.045 |  27.641 |  32.978 |    87 | 3.6% |            16.1× | ok                                                                                              |
| 1000 | node           |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | emittery       |       — |       — |       — |       — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## chain

Build and activate D service-linked plugins in topological order, reading each
predecessor once. Avvio uses manual ordered properties; Effect accumulates
Context layers. This does not measure resolving a reverse-registered graph.
Reverse-order registration and a graph profile would change conclusions about
dependency scheduling.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 |  Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | -----: | -----: | -----: | -----: | -----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |  0.344 |  0.257 |  2.527 | 11.046 |   2904 | 3.8% |                — | ok                                                                                              |
|    1 | cordis         |  0.190 |  0.144 |  0.315 | 10.158 |   5256 | 3.9% |            1.81× | ok                                                                                              |
|    1 | avvio          |  0.013 |  0.008 |  0.027 |  0.106 |  77531 | 4.0% |            26.7× | ok                                                                                              |
|    1 | effect         |  0.009 |  0.006 |  0.021 |  0.049 | 110711 | 3.6% |            38.1× | ok                                                                                              |
|    1 | node           |      — |      — |      — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |      — |      — |      — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | graft          |  3.298 |  2.647 | 13.421 | 15.934 |    303 | 3.6% |                — | ok                                                                                              |
|   10 | cordis         |  1.657 |  1.347 | 11.733 | 13.577 |    603 | 3.7% |            1.99× | ok                                                                                              |
|   10 | avvio          |  0.073 |  0.043 |  0.127 |  6.524 |  13778 | 3.5% |            45.4× | ok                                                                                              |
|   10 | effect         |  0.078 |  0.061 |  0.125 |  1.724 |  12881 | 3.2% |            42.5× | ok                                                                                              |
|   10 | node           |      — |      — |      — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | emittery       |      — |      — |      — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | graft          | 45.806 | 45.255 | 70.238 | 76.795 |     22 | 3.5% |                — | ok                                                                                              |
|  100 | cordis         | 25.256 | 22.805 | 40.671 | 45.600 |     40 | 3.2% |            1.81× | ok                                                                                              |
|  100 | avvio          |  0.695 |  0.462 |  5.485 | 13.964 |   1440 | 3.7% |            66.0× | ok                                                                                              |
|  100 | effect         |  1.330 |  1.036 | 10.137 | 12.348 |    752 | 3.3% |            34.4× | ok                                                                                              |
|  100 | node           |      — |      — |      — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |      — |      — |      — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## service

A dependent performs 10000 lookups and synchronous method calls, accumulating a
checksum. Graft and Effect yield a Context service on each call; cordis uses its
proxy and avvio an application property. Profiles separating Effect interpreter
work from lookup work would change the explanation; this is not RPC or an
effectful service method.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 |     Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | -----: | -----: | -----: | -----: | --------: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |  1.735 |  1.410 | 11.501 | 12.536 |   5764292 | 3.3% |                — | ok                                                                                              |
|    1 | cordis         | 54.431 | 56.599 | 68.800 | 72.816 |    183717 | 2.2% |          0.0319× | ok                                                                                              |
|    1 | avvio          |  0.093 |  0.080 |  0.150 |  0.376 | 107751113 | 3.6% |            18.7× | ok                                                                                              |
|    1 | effect         |  1.585 |  1.314 | 11.081 | 11.824 |   6310999 | 3.2% |            1.09× | ok                                                                                              |
|    1 | node           |      — |      — |      — |      — |         — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |      — |      — |      — |      — |         — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## events-emit

Completed ordered broadcast with synchronous handler bodies. Graft emit, cordis
emit, Node/avvio emit, emittery emitSerial and a raw Effect loop all call every
handler. Promise and Effect scheduling differ even though the work completes.
Graft restores context and owns invocation scopes. Async-body and allocation
profiles would change the conclusion.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 |    Ops/s |  RME | Reference / this | Status |
| ---: | -------------- | -----: | -----: | -----: | -----: | -------: | ---: | ---------------: | ------ |
|    1 | graft          |  0.961 |  0.779 |  2.896 | 11.019 |   104034 | 3.1% |                — | ok     |
|    1 | cordis         |  0.631 |  0.506 |  3.838 | 10.789 |   158579 | 3.4% |            1.52× | ok     |
|    1 | avvio          |  0.002 |  0.001 |  0.003 |  0.017 | 54333681 | 3.0% |             522× | ok     |
|    1 | effect         |  0.020 |  0.013 |  0.037 |  0.159 |  5108633 | 3.6% |            49.1× | ok     |
|    1 | node           |  0.002 |  0.002 |  0.003 |  0.015 | 54915931 | 3.2% |             528× | ok     |
|    1 | emittery       |  0.155 |  0.127 |  0.242 |  9.395 |   644289 | 3.3% |            6.19× | ok     |
|   10 | graft          |  5.554 |  4.798 | 14.558 | 16.332 |    18004 | 3.0% |                — | ok     |
|   10 | cordis         |  0.790 |  0.637 |  4.165 | 12.479 |   126627 | 3.6% |            7.03× | ok     |
|   10 | avvio          |  0.009 |  0.007 |  0.018 |  0.033 | 11419039 | 3.6% |             634× | ok     |
|   10 | effect         |  0.133 |  0.103 |  0.226 |  8.590 |   749211 | 3.2% |            41.6× | ok     |
|   10 | node           |  0.008 |  0.007 |  0.017 |  0.030 | 12421019 | 3.0% |             690× | ok     |
|   10 | emittery       |  0.206 |  0.175 |  0.691 |  9.532 |   484263 | 3.1% |            26.9× | ok     |
|  100 | graft          | 52.854 | 55.216 | 59.745 | 62.167 |     1892 | 2.0% |                — | ok     |
|  100 | cordis         |  2.632 |  2.124 | 12.477 | 14.613 |    38001 | 3.4% |            20.1× | ok     |
|  100 | avvio          |  0.067 |  0.056 |  0.104 |  0.199 |  1482268 | 4.0% |             783× | ok     |
|  100 | effect         |  1.306 |  1.077 |  7.531 | 10.936 |    76541 | 3.8% |            40.5× | ok     |
|  100 | node           |  0.067 |  0.056 |  0.096 |  0.189 |  1485727 | 3.3% |             785× | ok     |
|  100 | emittery       |  0.777 |  0.656 |  1.492 | 10.932 |   128706 | 3.1% |            68.0× | ok     |

## events-sequential

Awaited ordered broadcast: Graft emit, cordis serial with all handlers returning
undefined, emittery emitSerial and a raw Effect loop. Handler bodies are
synchronous; this does not establish async I/O throughput. Cordis serial can
short-circuit on a value. Async handler and cancellation measurements would
change interpretation.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 |   Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | -----: | -----: | -----: | -----: | ------: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |  0.998 |  0.808 |  3.833 | 11.551 |  100211 | 3.2% |                — | ok                                                                                              |
|    1 | cordis         |  0.713 |  0.579 |  3.293 | 10.896 |  140158 | 3.3% |            1.40× | ok                                                                                              |
|    1 | avvio          |      — |      — |      — |      — |       — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|    1 | effect         |  0.018 |  0.014 |  0.030 |  0.324 | 5499422 | 3.4% |            54.9× | ok                                                                                              |
|    1 | node           |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |  0.161 |  0.132 |  0.271 |  9.621 |  619371 | 3.2% |            6.18× | ok                                                                                              |
|   10 | graft          |  5.525 |  4.823 | 15.114 | 17.102 |   18100 | 3.0% |                — | ok                                                                                              |
|   10 | cordis         |  0.971 |  0.781 |  4.237 | 11.028 |  103004 | 3.3% |            5.69× | ok                                                                                              |
|   10 | avvio          |      — |      — |      — |      — |       — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|   10 | effect         |  0.137 |  0.103 |  0.239 |  8.790 |  728431 | 3.3% |            40.2× | ok                                                                                              |
|   10 | node           |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | emittery       |  0.221 |  0.183 |  0.808 |  9.803 |  451700 | 3.2% |            25.0× | ok                                                                                              |
|  100 | graft          | 54.776 | 55.864 | 69.860 | 73.045 |    1826 | 2.4% |                — | ok                                                                                              |
|  100 | cordis         |  3.719 |  2.883 | 14.190 | 16.500 |   26889 | 3.9% |            14.7× | ok                                                                                              |
|  100 | avvio          |      — |      — |      — |      — |       — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|  100 | effect         |  1.559 |  1.245 | 10.431 | 11.799 |   64140 | 3.3% |            35.1× | ok                                                                                              |
|  100 | node           |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |  0.770 |  0.653 |  1.526 | 10.732 |  129932 | 3.0% |            71.2× | ok                                                                                              |

## events-parallel

Await all handlers: Graft parallel, cordis parallel, emittery emit, and raw
Effect PubSub with one subscription and scoped consumer fiber per handler per
dispatch. Discard result arrays consistently. PubSub delivery is a substitute
for direct callbacks and includes publish/take/join. A persistent-consumer
PubSub design and allocation profiles would change comparisons.

| Size | Implementation |   Mean |    p50 |     p99 |    p999 |  Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | -----: | -----: | ------: | ------: | -----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |  2.121 |  1.723 |  11.704 |  13.375 |  47153 | 3.3% |                — | ok                                                                                              |
|    1 | cordis         |  0.799 |  0.641 |   3.920 |  12.395 | 125141 | 3.6% |            2.65× | ok                                                                                              |
|    1 | avvio          |      — |      — |       — |       — |      — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|    1 | effect         |  0.452 |  0.379 |   1.050 |   9.892 | 221275 | 3.1% |            4.69× | ok                                                                                              |
|    1 | node           |      — |      — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |  0.219 |  0.186 |   0.758 |   9.893 | 456396 | 3.0% |            9.68× | ok                                                                                              |
|   10 | graft          |  9.275 |  8.281 |  19.437 |  21.129 |  10781 | 3.2% |                — | ok                                                                                              |
|   10 | cordis         |  1.144 |  0.931 |   9.654 |  11.697 |  87390 | 3.3% |            8.11× | ok                                                                                              |
|   10 | avvio          |      — |      — |       — |       — |      — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|   10 | effect         |  1.983 |  1.701 |  11.367 |  11.841 |  50435 | 3.1% |            4.68× | ok                                                                                              |
|   10 | node           |      — |      — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | emittery       |  0.403 |  0.344 |   0.915 |  10.553 | 248013 | 3.0% |            23.0× | ok                                                                                              |
|  100 | graft          | 78.686 | 76.328 | 109.758 | 128.530 |   1271 | 2.8% |                — | ok                                                                                              |
|  100 | cordis         |  5.008 |  4.074 |  16.006 |  17.938 |  19970 | 3.6% |            15.7× | ok                                                                                              |
|  100 | avvio          |      — |      — |       — |       — |      — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|  100 | effect         | 16.697 | 14.785 |  26.042 |  29.045 |   5989 | 3.0% |            4.71× | ok                                                                                              |
|  100 | node           |      — |      — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |  2.143 |  1.851 |  11.680 |  12.856 |  46656 | 3.2% |            36.7× | ok                                                                                              |

## events-bail

Visit H handlers; the last returns 7. Graft uses Option, cordis uses synchronous
bail, raw Effect loops manually. This measures worst-case traversal, not early
exit. Moving the answer to the first handler and profiling invocation scopes
would change conclusions.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 |   Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | -----: | -----: | -----: | -----: | ------: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |  0.965 |  0.766 |  3.430 | 11.041 |  103609 | 3.2% |                — | ok                                                                                              |
|    1 | cordis         |  0.644 |  0.517 |  3.757 | 10.818 |  155374 | 3.7% |            1.50× | ok                                                                                              |
|    1 | avvio          |      — |      — |      — |      — |       — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|    1 | effect         |  0.018 |  0.013 |  0.032 |  0.129 | 5477204 | 3.8% |            52.9× | ok                                                                                              |
|    1 | node           |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | graft          |  5.289 |  4.641 | 14.201 | 15.759 |   18907 | 2.7% |                — | ok                                                                                              |
|   10 | cordis         |  0.806 |  0.656 |  3.886 | 11.491 |  124029 | 3.5% |            6.56× | ok                                                                                              |
|   10 | avvio          |      — |      — |      — |      — |       — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|   10 | effect         |  0.136 |  0.106 |  0.246 |  8.909 |  733544 | 3.2% |            38.8× | ok                                                                                              |
|   10 | node           |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | emittery       |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | graft          | 52.720 | 54.345 | 63.862 | 64.759 |    1897 | 2.1% |                — | ok                                                                                              |
|  100 | cordis         |  2.593 |  2.095 | 12.432 | 14.827 |   38565 | 3.5% |            20.3× | ok                                                                                              |
|  100 | avvio          |      — |      — |      — |      — |       — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|  100 | effect         |  1.472 |  1.151 |  7.988 | 11.267 |   67918 | 2.8% |            35.8× | ok                                                                                              |
|  100 | node           |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## events-serial-bail

Awaited bail: Graft bail and cordis serial; the last handler returns 7. Cordis
bail itself does not await Promises. Raw Effect loops manually. Bodies are
synchronous; async suspension and first-handler answers could change
conclusions.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 |   Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | -----: | -----: | -----: | -----: | ------: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |  1.019 |  0.793 |  4.049 | 11.518 |   98169 | 3.2% |                — | ok                                                                                              |
|    1 | cordis         |  0.733 |  0.586 |  3.656 | 11.002 |  136480 | 3.5% |            1.39× | ok                                                                                              |
|    1 | avvio          |      — |      — |      — |      — |       — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|    1 | effect         |  0.018 |  0.013 |  0.030 |  0.142 | 5471487 | 3.8% |            55.7× | ok                                                                                              |
|    1 | node           |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | graft          |  5.553 |  4.812 | 14.949 | 16.943 |   18008 | 3.0% |                — | ok                                                                                              |
|   10 | cordis         |  0.958 |  0.767 |  9.899 | 12.680 |  104358 | 3.7% |            5.80× | ok                                                                                              |
|   10 | avvio          |      — |      — |      — |      — |       — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|   10 | effect         |  0.137 |  0.106 |  0.249 |  9.583 |  730822 | 3.3% |            40.6× | ok                                                                                              |
|   10 | node           |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | emittery       |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | graft          | 53.139 | 55.469 | 63.593 | 64.091 |    1882 | 2.2% |                — | ok                                                                                              |
|  100 | cordis         |  3.497 |  2.861 | 12.965 | 14.847 |   28594 | 3.1% |            15.2× | ok                                                                                              |
|  100 | avvio          |      — |      — |      — |      — |       — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|  100 | effect         |  1.387 |  1.125 |  8.991 | 11.093 |   72110 | 3.0% |            38.3× | ok                                                                                              |
|  100 | node           |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |      — |      — |      — |      — |       — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## events-waterfall

H middleware wrappers add one to the terminal result 0. Graft waterfall supports
next(input), while pinned cordis waterfall uses next() with captured arguments.
Only output wrapping overlaps; input transformation and repeated next are not
compared. Adding context restoration or shared-next semantics to a baseline
could change the gap.

| Size | Implementation |   Mean |    p50 |     p99 |    p999 |  Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | -----: | -----: | ------: | ------: | -----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          |  1.603 |  1.250 |  10.947 |  13.241 |  62382 | 3.5% |                — | ok                                                                                              |
|    1 | cordis         |  0.737 |  0.594 |   3.922 |  11.030 | 135653 | 3.6% |            2.17× | ok                                                                                              |
|    1 | avvio          |      — |      — |       — |       — |      — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|    1 | effect         |  0.170 |  0.120 |   0.284 |   9.983 | 587806 | 3.6% |            9.42× | ok                                                                                              |
|    1 | node           |      — |      — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |      — |      — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | graft          | 10.073 |  9.078 |  21.056 |  25.931 |   9928 | 3.5% |                — | ok                                                                                              |
|   10 | cordis         |  1.682 |  1.395 |  11.237 |  12.958 |  59447 | 3.3% |            5.99× | ok                                                                                              |
|   10 | avvio          |      — |      — |       — |       — |      — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|   10 | effect         |  1.448 |  1.011 |  10.292 |  15.558 |  69055 | 3.5% |            6.96× | ok                                                                                              |
|   10 | node           |      — |      — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | emittery       |      — |      — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | graft          | 95.097 | 92.616 | 137.404 | 137.825 |   1052 | 2.3% |                — | ok                                                                                              |
|  100 | cordis         | 11.016 |  9.444 |  20.835 |  25.350 |   9078 | 3.4% |            8.63× | ok                                                                                              |
|  100 | avvio          |      — |      — |       — |       — |      — |    — |                — | N/A: Only synchronous EventEmitter dispatch is inherited; use events-emit for that overlap.     |
|  100 | effect         | 12.778 | 10.603 |  26.476 |  30.448 |   7826 | 3.9% |            7.44× | ok                                                                                              |
|  100 | node           |      — |      — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|  100 | emittery       |      — |      — |       — |       — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## config-update

One sequential config update after startup, preserving activation. Graft
Schema.Struct decodes Schema.Int; cordis uses an internal/update hook and no
optional Config schema; raw Effect assigns a value manually. This is a
default-validation comparison. Equal schema validation could change the gap.

| Size | Implementation |  Mean |   p50 |   p99 |   p999 |  Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | ----: | ----: | ----: | -----: | -----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          | 0.120 | 0.084 | 0.270 | 10.005 |   8353 | 4.0% |                — | ok                                                                                              |
|    1 | cordis         | 0.040 | 0.029 | 0.069 |  0.356 |  25154 | 3.8% |            3.01× | ok                                                                                              |
|    1 | avvio          |     — |     — |     — |      — |      — |    — |                — | N/A: No runtime plugin configuration update or restart API.                                     |
|    1 | effect         | 0.002 | 0.001 | 0.004 |  0.018 | 548601 | 3.3% |            65.7× | ok                                                                                              |
|    1 | node           |     — |     — |     — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |     — |     — |     — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## config-restart

Change config and await teardown and a second activation. Graft decodes the same
integer schema; cordis uses update without an update hook; raw Effect
closes/rebuilds a scope manually. Schema, queueing and restart profiles could
change attribution.

| Size | Implementation |  Mean |   p50 |   p99 |   p999 |  Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | ----: | ----: | ----: | -----: | -----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
|    1 | graft          | 0.237 | 0.180 | 2.253 | 10.432 |   4211 | 3.6% |                — | ok                                                                                              |
|    1 | cordis         | 0.109 | 0.080 | 0.172 |  8.951 |   9177 | 3.4% |            2.18× | ok                                                                                              |
|    1 | avvio          |     — |     — |     — |      — |      — |    — |                — | N/A: No runtime plugin configuration update or restart API.                                     |
|    1 | effect         | 0.006 | 0.004 | 0.016 |  0.033 | 156586 | 3.5% |            37.2× | ok                                                                                              |
|    1 | node           |     — |     — |     — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|    1 | emittery       |     — |     — |     — |      — |      — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## replace

One Graft.replace transaction for K distinct definitions, then wait for all
replacement definitions to be Active. Atomicity concerns the spec/alias
transaction, not simultaneous activation. Pinned cordis has no replacement API.
There is no competitor speed ratio; a compatible atomic API would permit a
comparison.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 | Ops/s |  RME | Reference / this | Status                                                                                                          |
| ---: | -------------- | -----: | -----: | -----: | -----: | ----: | ---: | ---------------: | --------------------------------------------------------------------------------------------------------------- |
|    1 | graft          |  0.312 |  0.262 |  0.796 | 10.048 |  3203 | 3.0% |                — | ok                                                                                                              |
|    1 | cordis         |      — |      — |      — |      — |     — |    — |                — | N/A: Pinned cordis RegistryService has no replace API; unload/reload does not provide atomic alias replacement. |
|    1 | avvio          |      — |      — |      — |      — |     — |    — |                — | N/A: No runtime plugin replacement API.                                                                         |
|    1 | effect         |      — |      — |      — |      — |     — |    — |                — | N/A: Raw Layer/Scope has no plugin identity or atomic alias replacement API.                                    |
|    1 | node           |      — |      — |      — |      — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API.                 |
|    1 | emittery       |      — |      — |      — |      — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API.                 |
|   10 | graft          |  2.505 |  1.926 | 12.335 | 15.069 |   399 | 3.8% |                — | ok                                                                                                              |
|   10 | cordis         |      — |      — |      — |      — |     — |    — |                — | N/A: Pinned cordis RegistryService has no replace API; unload/reload does not provide atomic alias replacement. |
|   10 | avvio          |      — |      — |      — |      — |     — |    — |                — | N/A: No runtime plugin replacement API.                                                                         |
|   10 | effect         |      — |      — |      — |      — |     — |    — |                — | N/A: Raw Layer/Scope has no plugin identity or atomic alias replacement API.                                    |
|   10 | node           |      — |      — |      — |      — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API.                 |
|   10 | emittery       |      — |      — |      — |      — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API.                 |
|  100 | graft          | 34.352 | 32.728 | 47.837 | 50.429 |    29 | 3.5% |                — | ok                                                                                                              |
|  100 | cordis         |      — |      — |      — |      — |     — |    — |                — | N/A: Pinned cordis RegistryService has no replace API; unload/reload does not provide atomic alias replacement. |
|  100 | avvio          |      — |      — |      — |      — |     — |    — |                — | N/A: No runtime plugin replacement API.                                                                         |
|  100 | effect         |      — |      — |      — |      — |     — |    — |                — | N/A: Raw Layer/Scope has no plugin identity or atomic alias replacement API.                                    |
|  100 | node           |      — |      — |      — |      — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API.                 |
|  100 | emittery       |      — |      — |      — |      — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API.                 |

## memory-cycles

Retained heap growth after M cycles of 10 plugins inside one persistent root,
after warmup and forced GC. Report bytes per batch and slope across checkpoints,
including negative noise. Avvio has no runtime unload. A repeatable positive
slope over larger M and heap snapshots would support a leak claim; one positive
delta does not.

| Size | Implementation |                  Mean |       p50 |        p99 |       p999 | Ops/s |    RME | Reference / this | Status                                                                                          |
| ---: | -------------- | --------------------: | --------: | ---------: | ---------: | ----: | -----: | ---------------: | ----------------------------------------------------------------------------------------------- |
|   10 | graft          | 31828.400 bytes/batch |   700.000 | 535444.320 | 643289.232 |     — | 234.3% |                — | noisy                                                                                           |
|   10 | cordis         | 23860.400 bytes/batch | 13612.000 | 192808.160 | 227749.616 |     — | 104.8% |                — | noisy                                                                                           |
|   10 | avvio          |                     — |         — |          — |          — |     — |      — |                — | N/A: No runtime unload; recreating the entire loader would measure a different lifecycle.       |
|   10 | effect         |  7648.800 bytes/batch |   644.000 | 114595.280 | 136703.528 |     — | 208.3% |                — | noisy                                                                                           |
|   10 | node           |                     — |         — |          — |          — |     — |      — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
|   10 | emittery       |                     — |         — |          — |          — |     — |      — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

A positive retained delta alone is not a leak finding. Use the per-sample
checkpoint slopes in JSON and repeat at larger cycle counts before drawing that
conclusion.

## memory-steady

Forced-GC heap delta for 1000 live independent plugins relative to an empty
root, divided by N. Includes plugin handles and framework bookkeeping, excludes
import/root cost. JIT and GC noise remain. Repeated process-level deltas and
heap dominator analysis would change attribution.

| Size | Implementation |                   Mean |       p50 |       p99 |      p999 | Ops/s |  RME | Reference / this | Status                                                                                          |
| ---: | -------------- | ---------------------: | --------: | --------: | --------: | ----: | ---: | ---------------: | ----------------------------------------------------------------------------------------------- |
| 1000 | graft          | 33907.716 bytes/plugin | 34335.220 | 34499.312 | 34504.021 |     — | 3.0% |                — | ok                                                                                              |
| 1000 | cordis         | 10264.162 bytes/plugin | 10255.892 | 10323.588 | 10327.372 |     — | 0.1% |                — | ok                                                                                              |
| 1000 | avvio          |   821.180 bytes/plugin |   816.332 |   858.766 |   860.705 |     — | 1.0% |                — | ok                                                                                              |
| 1000 | effect         |  2089.065 bytes/plugin |  2088.668 |  2110.040 |  2110.040 |     — | 0.2% |                — | ok                                                                                              |
| 1000 | node           |                      — |         — |         — |         — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |
| 1000 | emittery       |                      — |         — |         — |         — |     — |    — |                — | N/A: Event dispatch baseline only; no plugin lifecycle, service graph, bail, or middleware API. |

## import

Fresh-process dynamic import latency measured inside Node, including dependency
evaluation and excluding process launch. A second metric records process wall
time. Every sample gets a new process; there is no module-cache warmup.
Filesystem cache is warm and uncontrolled. Node EventEmitter is a built-in
module; its import can reuse bootstrap initialization and is not a cold userland
initialization measurement. Cold-cache runs or dependency import traces would
change interpretation.

| Size | Implementation |    Mean |     p50 |     p99 |    p999 | Ops/s |  RME | Reference / this | Status |
| ---: | -------------- | ------: | ------: | ------: | ------: | ----: | ---: | ---------------: | ------ |
|    1 | graft          | 242.159 | 241.083 | 276.689 | 292.377 |     4 | 0.5% |                — | ok     |
|    1 | cordis         |   4.409 |   4.255 |   7.021 |  10.054 |   227 | 1.5% |            54.9× | ok     |
|    1 | avvio          |   6.126 |   5.955 |   9.171 |   9.968 |   163 | 1.1% |            39.5× | ok     |
|    1 | effect         | 230.756 | 228.972 | 271.270 | 278.606 |     4 | 0.5% |            1.05× | ok     |
|    1 | node           |   0.173 |   0.164 |   0.293 |   0.428 |  5776 | 2.0% |         1.40e+3× | ok     |
|    1 | emittery       |   1.988 |   1.925 |   2.602 |   4.969 |   503 | 1.3% |             122× | ok     |

## remote-r1-start

Entry loading through an actual consumer's first echo and identity reply. Runner
server/listener readiness is prepared outside timing. Remote includes public
assembly, config validation, process/module startup, contract negotiation and
proxy publication. Compare repeated processes or disabled module caches to
distinguish startup sources.

| Size | Implementation |     Mean |      p50 |      p99 |     p999 | Ops/s |   RME | Reference / this | Status                                                                                                                                       |
| ---: | -------------- | -------: | -------: | -------: | -------: | ----: | ----: | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | in-process     |    2.673 |    1.491 |   12.966 |   14.020 |   374 | 58.7% |                — | noisy                                                                                                                                        |
|    1 | remote-local   |  866.756 |  864.343 |  938.177 |  948.955 |     1 |  1.5% |         0.00308× | ok                                                                                                                                           |
|    1 | remote-worker  |  698.801 |  694.861 |  756.228 |  757.641 |     1 |  2.0% |         0.00382× | ok                                                                                                                                           |
|    1 | remote-unix    | 1462.665 | 1462.655 | 1569.412 | 1578.430 |     1 |  1.8% |         0.00183× | ok                                                                                                                                           |
|    1 | remote-ws      | 1459.621 | 1451.742 | 1611.528 | 1612.520 |     1 |  2.2% |         0.00183× | ok                                                                                                                                           |
|    1 | raw-worker     |        — |        — |        — |        — |     — |     — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|    1 | raw-ipc        |        — |        — |        — |        — |     — |     — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |

## remote-r1-stop

Entry disposal through native child exit or Worker exit, then consumer
settlement. Scope teardown is outside timing. Channel closure alone is
insufficient. Grace periods and log draining can explain gaps; inspect native
exit records and cleanup causes before assigning transport cost.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 | Ops/s |   RME | Reference / this | Status                                                                                                                                       |
| ---: | -------------- | -----: | -----: | -----: | -----: | ----: | ----: | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | in-process     |  1.032 |  0.641 |  5.471 |  6.346 |   969 | 63.6% |                — | noisy                                                                                                                                        |
|    1 | remote-local   | 43.707 | 43.922 | 49.160 | 49.360 |    23 |  3.5% |          0.0236× | ok                                                                                                                                           |
|    1 | remote-worker  | 21.003 | 20.141 | 26.657 | 26.853 |    48 |  7.0% |          0.0492× | noisy                                                                                                                                        |
|    1 | remote-unix    | 75.011 | 73.928 | 92.346 | 94.621 |    13 |  4.3% |          0.0138× | ok                                                                                                                                           |
|    1 | remote-ws      | 76.665 | 75.478 | 87.051 | 87.877 |    13 |  3.1% |          0.0135× | ok                                                                                                                                           |
|    1 | raw-worker     |      — |      — |      — |      — |     — |     — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|    1 | raw-ipc        |      — |      — |      — |      — |     — |     — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |

## remote-r2-call

One awaited tiny echo per sample through the same consumer service. p999 is
empirical: 5000 full-run calls provide only about five observations in its upper
0.1%. Raw worker uses structured clone; raw IPC uses Node's default JSON
serialization. Differences include Effect RPC, Schema, framing, copies and
scheduling, so subtraction is an aggregate overhead estimate, not pure framing
cost.

| Size | Implementation |  Mean |   p50 |   p99 |  p999 |  Ops/s |   RME | Reference / this | Status |
| ---: | -------------- | ----: | ----: | ----: | ----: | -----: | ----: | ---------------: | ------ |
|    1 | in-process     | 0.007 | 0.004 | 0.027 | 0.070 | 147431 | 31.6% |                — | noisy  |
|    1 | remote-local   | 0.626 | 0.576 | 2.468 | 3.695 |   1597 |  1.3% |          0.0108× | ok     |
|    1 | remote-worker  | 0.568 | 0.524 | 2.235 | 3.701 |   1761 |  1.4% |          0.0119× | ok     |
|    1 | remote-unix    | 1.195 | 1.096 | 3.760 | 6.447 |    837 |  1.3% |         0.00568× | ok     |
|    1 | remote-ws      | 1.346 | 1.219 | 4.054 | 7.287 |    743 |  1.2% |         0.00504× | ok     |
|    1 | raw-worker     | 0.028 | 0.024 | 0.052 | 0.179 |  36294 |  7.6% |           0.246× | noisy  |
|    1 | raw-ipc        | 0.051 | 0.043 | 0.121 | 0.396 |  19539 |  3.6% |           0.133× | ok     |

## remote-r5-stream

A supported Rpc stream emits exactly 0..99; timing ends after stream completion.
Chunking/backpressure differs from eager in-process iteration. Larger chunks or
demand-driven consumers could reverse a result; streams are not equivalent to
100 independent unary calls.

| Size | Implementation |  Mean |   p50 |    p99 |   p999 | Ops/s |   RME | Reference / this | Status                                                                                                                                       |
| ---: | -------------- | ----: | ----: | -----: | -----: | ----: | ----: | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
|  100 | in-process     | 0.038 | 0.033 |  0.070 |  0.070 | 25985 | 16.2% |                — | noisy                                                                                                                                        |
|  100 | remote-local   | 3.077 | 2.805 |  8.166 |  9.694 |   325 | 16.9% |          0.0125× | noisy                                                                                                                                        |
|  100 | remote-worker  | 3.366 | 2.868 |  9.393 | 10.186 |   297 | 18.5% |          0.0114× | noisy                                                                                                                                        |
|  100 | remote-unix    | 6.536 | 5.908 | 15.513 | 16.354 |   153 | 17.5% |         0.00589× | noisy                                                                                                                                        |
|  100 | remote-ws      | 5.278 | 4.496 | 10.658 | 10.915 |   189 | 13.8% |         0.00729× | noisy                                                                                                                                        |
|  100 | raw-worker     |     — |     — |      — |      — |     — |     — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|  100 | raw-ipc        |     — |     — |      — |      — |     — |     — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |

## remote-r6-config

An in-process updater keeps its service and consumer active; Remote restarts the
execution and consumer. Timing ends after the consumer can call the new value,
and the old execution has really exited. This is intentionally a semantic
comparison; restart counts differ as documented and tested.

| Size | Implementation |     Mean |      p50 |      p99 |     p999 | Ops/s |    RME | Reference / this | Status                                                                                                                                       |
| ---: | -------------- | -------: | -------: | -------: | -------: | ----: | -----: | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | in-process     |    1.084 |    0.495 |    9.003 |   10.687 |   923 | 108.0% |                — | noisy                                                                                                                                        |
|    1 | remote-local   |  886.988 |  882.433 |  946.411 |  950.926 |     1 |   1.7% |         0.00122× | ok                                                                                                                                           |
|    1 | remote-worker  |  705.356 |  702.859 |  792.864 |  804.076 |     1 |   2.3% |         0.00154× | ok                                                                                                                                           |
|    1 | remote-unix    | 1509.301 | 1508.262 | 1636.683 | 1645.619 |     1 |   2.1% |        0.000718× | ok                                                                                                                                           |
|    1 | remote-ws      | 1528.991 | 1518.622 | 1614.857 | 1618.002 |     1 |   1.3% |        0.000709× | ok                                                                                                                                           |
|    1 | raw-worker     |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|    1 | raw-ipc        |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |

## remote-r8-loop

The identical fixed integer CPU loop runs behind the service. A reverse notice
schedules an unrelated in-process service call for 5 ms later; reported latency
includes timer delay until that call completes. monitorEventLoopDelay is primed
before and drained after work. Transport round trips and spare CPU capacity
matter; a saturated CPU or a larger/smaller loop could change the worker/local
trade-off.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 | Ops/s |  RME | Reference / this | Status                                                                                                                                       |
| ---: | -------------- | -----: | -----: | -----: | -----: | ----: | ---: | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | in-process     | 55.592 | 55.484 | 56.106 | 56.124 |    18 | 0.8% |                — | ok                                                                                                                                           |
|    1 | remote-local   | 65.366 | 63.776 | 72.390 | 72.705 |    15 | 9.0% |           0.850× | noisy                                                                                                                                        |
|    1 | remote-worker  | 63.998 | 63.923 | 64.844 | 64.849 |    16 | 1.9% |           0.869× | ok                                                                                                                                           |
|    1 | remote-unix    | 66.895 | 66.195 | 68.493 | 68.528 |    15 | 2.4% |           0.831× | ok                                                                                                                                           |
|    1 | remote-ws      | 64.864 | 64.621 | 65.609 | 65.611 |    15 | 1.5% |           0.857× | ok                                                                                                                                           |
|    1 | raw-worker     |      — |      — |      — |      — |     — |    — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|    1 | raw-ipc        |      — |      — |      — |      — |     — |    — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |

| Connection    | CPU call mean, ms | Loop delay p99 mean, ms | Worst loop stall, ms | Unrelated call mean, ms |
| ------------- | ----------------: | ----------------------: | -------------------: | ----------------------: |
| in-process    |            55.592 |                  56.767 |               57.246 |                  55.637 |
| remote-local  |            65.366 |                   2.084 |                2.376 |                   5.694 |
| remote-worker |            63.998 |                   1.769 |                3.484 |                   5.618 |
| remote-unix   |            66.895 |                   1.670 |                2.574 |                   5.399 |
| remote-ws     |            64.864 |                   1.667 |                1.867 |                   4.873 |

## remote-r10-failure

Intentional process.exit(73), after an acknowledged reverse notice. Primary
clock is host notice receipt immediately before the exit request, not the
unobservable exact OS exit instant; also record native exit-event to Failed and
consumer stop timestamps, which may be negative if protocol failure is detected
before the native exit callback. Crash causes are retained. Other failure types
and runner lease expiry need separate measurements.

| Size | Implementation |   Mean |    p50 |    p99 |   p999 | Ops/s |   RME | Reference / this | Status                                                                                                                                       |
| ---: | -------------- | -----: | -----: | -----: | -----: | ----: | ----: | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | in-process     |      — |      — |      — |      — |     — |     — |                — | N/A: process.exit terminates the whole host. A separate crash witness verifies this; no surviving fork can reach Failed or stop a consumer.  |
|    1 | remote-local   | 33.348 | 30.184 | 46.056 | 46.586 |    30 | 32.1% |                — | noisy                                                                                                                                        |
|    1 | remote-worker  | 14.718 | 14.478 | 21.719 | 21.973 |    68 | 43.7% |                — | noisy                                                                                                                                        |
|    1 | remote-unix    | 65.278 | 57.730 | 83.867 | 84.252 |    15 | 28.7% |                — | noisy                                                                                                                                        |
|    1 | remote-ws      | 58.348 | 56.263 | 75.828 | 76.561 |    17 | 26.1% |                — | noisy                                                                                                                                        |
|    1 | raw-worker     |      — |      — |      — |      — |     — |     — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|    1 | raw-ipc        |      — |      — |      — |      — |     — |     — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |

| Connection    | Notice to Failed, ms | Native exit to Failed, ms | Notice to consumer stopped, ms | Native exit code |
| ------------- | -------------------: | ------------------------: | -----------------------------: | ---------------: |
| remote-local  |               33.348 |                     9.814 |                         34.097 |               73 |
| remote-worker |               14.718 |                     9.259 |                         15.455 |               73 |
| remote-unix   |               65.278 |                    26.286 |                         66.128 |               73 |
| remote-ws     |               58.348 |                    23.841 |                         59.072 |               73 |

## remote-r3-throughput

256 completed echoes per batch, bounded to 1, 16 or 256 in flight. The remote
data admission default is 16 per direction, so 256 submitted requests may queue.
Confirm all sequence numbers and final call count. A larger payload, different
admission settings or multiple producer processes could change the ranking.

| Size | Implementation |    Mean |     p50 |     p99 |    p999 |  Ops/s |   RME | Reference / this | Status |
| ---: | -------------- | ------: | ------: | ------: | ------: | -----: | ----: | ---------------: | ------ |
|    1 | in-process     |   1.698 |   0.954 |   9.523 |  10.411 | 150765 | 46.4% |                — | noisy  |
|    1 | remote-local   | 165.007 | 161.561 | 197.656 | 201.040 |   1551 |  3.4% |          0.0103× | ok     |
|    1 | remote-worker  | 156.841 | 155.281 | 189.897 | 192.571 |   1632 |  3.9% |          0.0108× | ok     |
|    1 | remote-unix    | 301.015 | 295.679 | 367.574 | 368.293 |    850 |  3.4% |         0.00564× | ok     |
|    1 | remote-ws      | 332.670 | 327.556 | 393.257 | 403.532 |    770 |  2.6% |         0.00510× | ok     |
|    1 | raw-worker     |   8.518 |   8.093 |  13.185 |  13.621 |  30053 |  7.2% |           0.199× | noisy  |
|    1 | raw-ipc        |  10.754 |  10.309 |  16.605 |  17.423 |  23805 |  6.6% |           0.158× | noisy  |
|   16 | in-process     |   1.563 |   0.964 |   7.357 |   8.959 | 163787 | 38.2% |                — | noisy  |
|   16 | remote-local   |  57.095 |  55.080 |  76.821 |  78.114 |   4484 |  6.1% |          0.0274× | noisy  |
|   16 | remote-worker  |  53.994 |  55.108 |  62.305 |  62.521 |   4741 |  3.3% |          0.0289× | ok     |
|   16 | remote-unix    | 156.964 | 155.994 | 178.454 | 179.018 |   1631 |  3.0% |         0.00996× | ok     |
|   16 | remote-ws      | 180.521 | 179.318 | 234.191 | 238.687 |   1418 |  4.1% |         0.00866× | ok     |
|   16 | raw-worker     |   1.389 |   1.342 |   1.747 |   1.775 | 184348 |  3.7% |            1.13× | ok     |
|   16 | raw-ipc        |   1.594 |   1.292 |   5.477 |   6.778 | 160561 | 25.1% |           0.980× | noisy  |
|  256 | in-process     |   2.000 |   1.050 |   9.676 |  10.758 | 128014 | 39.3% |                — | noisy  |
|  256 | remote-local   |  61.159 |  60.677 |  82.287 |  87.221 |   4186 |  4.7% |          0.0327× | ok     |
|  256 | remote-worker  |  57.755 |  55.611 |  78.542 |  79.055 |   4433 |  5.0% |          0.0346× | ok     |
|  256 | remote-unix    | 168.286 | 165.880 | 222.435 | 226.727 |   1521 |  4.2% |          0.0119× | ok     |
|  256 | remote-ws      | 184.851 | 184.323 | 212.825 | 215.363 |   1385 |  3.0% |          0.0108× | ok     |
|  256 | raw-worker     |   1.405 |   1.141 |   5.760 |   7.067 | 182180 | 30.8% |            1.42× | noisy  |
|  256 | raw-ipc        |   1.698 |   1.401 |   5.216 |   6.373 | 150742 | 21.6% |            1.18× | noisy  |

## remote-r3-batch

256 identical echo operations in one batch contract call; compares with 256
unary calls. All sequence numbers, results and service call counts must match.
Batching changes API granularity and the number of host runPromise bridges, so
it demonstrates whole-call amortization rather than framing alone. A real
workload needing streaming/early results may prefer smaller batches.

| Size | Implementation |  Mean |   p50 |    p99 |   p999 |   Ops/s |   RME | Reference / this | Status |
| ---: | -------------- | ----: | ----: | -----: | -----: | ------: | ----: | ---------------: | ------ |
|  256 | in-process     | 0.430 | 0.407 |  0.773 |  0.871 |  595143 |  8.3% |                — | noisy  |
|  256 | remote-local   | 3.408 | 3.147 |  8.315 |  8.968 |   75122 | 14.5% |           0.126× | noisy  |
|  256 | remote-worker  | 3.271 | 2.547 |  9.835 |  9.951 |   78264 | 23.7% |           0.132× | noisy  |
|  256 | remote-unix    | 4.953 | 4.509 | 12.473 | 13.899 |   51688 | 16.4% |          0.0868× | noisy  |
|  256 | remote-ws      | 5.230 | 4.715 | 10.072 | 10.282 |   48946 | 12.2% |          0.0822× | noisy  |
|  256 | raw-worker     | 0.240 | 0.219 |  0.462 |  0.505 | 1066009 | 10.6% |            1.79× | noisy  |
|  256 | raw-ipc        | 0.336 | 0.206 |  2.941 |  3.862 |  761512 | 78.2% |            1.28× | noisy  |

## remote-r4-payload

ASCII request/response text of exactly the displayed byte length. Runner framing
limits protocol payload to 1 MiB, including its JSON envelope; a 1 MiB business
string is larger than a valid frame. Direct local/worker paths are tested
independently. Rejections are boundary outcomes, never treated as successful
throughput or compared with successful calls. Different string contents and
codec shapes change the serialized size.

|    Size | Implementation |   Mean |    p50 |    p99 |   p999 | Ops/s |    RME | Reference / this | Status                              |
| ------: | -------------- | -----: | -----: | -----: | -----: | ----: | -----: | ---------------: | ----------------------------------- |
|     100 | in-process     |  0.019 |  0.018 |  0.037 |  0.038 | 51758 |  13.3% |                — | noisy                               |
|     100 | remote-local   |  2.338 |  1.882 |  8.169 |  9.311 |   428 |  24.6% |         0.00826× | noisy                               |
|     100 | remote-worker  |  2.054 |  1.671 |  7.144 |  7.981 |   487 |  24.2% |         0.00941× | noisy                               |
|     100 | remote-unix    |  2.995 |  2.731 |  6.016 |  6.062 |   334 |  12.3% |         0.00645× | noisy                               |
|     100 | remote-ws      |  3.068 |  2.521 |  7.856 |  8.165 |   326 |  18.3% |         0.00630× | noisy                               |
|     100 | raw-worker     |  0.051 |  0.044 |  0.106 |  0.111 | 19584 |  13.8% |           0.378× | noisy                               |
|     100 | raw-ipc        |  0.086 |  0.078 |  0.155 |  0.157 | 11571 |  13.0% |           0.224× | noisy                               |
|   10000 | in-process     |  0.020 |  0.016 |  0.049 |  0.049 | 50002 |  19.2% |                — | noisy                               |
|   10000 | remote-local   |  2.088 |  1.718 |  6.394 |  7.288 |   479 |  21.8% |         0.00958× | noisy                               |
|   10000 | remote-worker  |  1.987 |  1.626 |  7.615 |  8.517 |   503 |  27.5% |          0.0101× | noisy                               |
|   10000 | remote-unix    |  3.092 |  2.806 |  6.620 |  7.524 |   323 |  11.9% |         0.00647× | noisy                               |
|   10000 | remote-ws      |  3.592 |  3.150 |  7.417 |  7.689 |   278 |  13.0% |         0.00557× | noisy                               |
|   10000 | raw-worker     |  0.053 |  0.049 |  0.089 |  0.091 | 19007 |   9.6% |           0.380× | noisy                               |
|   10000 | raw-ipc        |  0.191 |  0.157 |  0.597 |  0.688 |  5226 |  22.5% |           0.105× | noisy                               |
| 1000000 | in-process     |  0.021 |  0.016 |  0.059 |  0.063 | 47396 |  22.1% |                — | noisy                               |
| 1000000 | remote-local   |  7.867 |  6.722 | 15.800 | 16.412 |   127 |  15.1% |         0.00268× | noisy                               |
| 1000000 | remote-worker  |  7.894 |  6.628 | 14.411 | 14.934 |   127 |  15.3% |         0.00267× | noisy                               |
| 1000000 | remote-unix    | 18.131 | 16.825 | 36.619 | 37.316 |    55 |  14.1% |         0.00116× | noisy                               |
| 1000000 | remote-ws      | 18.537 | 17.878 | 32.140 | 33.117 |    54 |  12.5% |         0.00114× | noisy                               |
| 1000000 | raw-worker     |  1.353 |  1.166 |  3.871 |  4.622 |   739 |  18.8% |          0.0156× | noisy                               |
| 1000000 | raw-ipc        |  4.874 |  3.665 | 13.918 | 15.939 |   205 |  21.6% |         0.00433× | noisy                               |
| 1048576 | in-process     |  0.019 |  0.015 |  0.041 |  0.044 | 52687 |  16.0% |                — | noisy                               |
| 1048576 | remote-local   |  8.166 |  7.000 | 16.574 | 17.011 |   122 |  15.7% |         0.00232× | noisy                               |
| 1048576 | remote-worker  |  8.595 |  7.576 | 14.038 | 14.453 |   116 |  13.1% |         0.00221× | noisy                               |
| 1048576 | remote-unix    |  9.233 |  5.933 | 16.074 | 16.260 |     — | 164.3% |                — | rejected; 3 cleanup causes retained |
| 1048576 | remote-ws      |  8.082 |  8.557 | 10.740 | 10.780 |     — |  91.2% |                — | rejected; 3 cleanup causes retained |
| 1048576 | raw-worker     |  1.278 |  1.205 |  4.696 |  5.884 |   782 |  27.7% |          0.0148× | noisy                               |
| 1048576 | raw-ipc        |  5.668 |  4.326 | 15.112 | 15.723 |   176 |  22.4% |         0.00335× | noisy                               |
| 1048577 | in-process     |  0.021 |  0.016 |  0.051 |  0.052 | 47991 |  20.1% |                — | noisy                               |
| 1048577 | remote-local   |  9.842 |  8.935 | 14.702 | 14.850 |   102 |   9.1% |         0.00212× | noisy                               |
| 1048577 | remote-worker  |  8.187 |  7.995 | 18.249 | 20.434 |   122 |  15.8% |         0.00255× | noisy                               |
| 1048577 | remote-unix    |  8.506 |  5.697 | 14.357 | 14.516 |     — | 152.6% |                — | rejected; 3 cleanup causes retained |
| 1048577 | remote-ws      |  9.200 |  8.127 | 14.211 | 14.323 |     — | 126.7% |                — | rejected; 3 cleanup causes retained |
| 1048577 | raw-worker     |  1.306 |  1.130 |  4.483 |  5.541 |   765 |  24.8% |          0.0159× | noisy                               |
| 1048577 | raw-ipc        |  4.960 |  3.863 | 10.791 | 11.208 |   202 |  18.9% |         0.00420× | noisy                               |

## remote-r7-footprint

Post-GC host heap delta divided by entries, plus process RSS and isolate heap
observations, at 1/10/50 entries in one Graft root with separate Api realms.
Worker RSS is process-wide: only total host RSS delta per entry is an estimate,
not individual worker RSS. Runner substitute: per-entry host heap/RSS and CPU
include the embedded runner server's session bookkeeping; server setup itself is
outside the baseline. These are combined host+runner costs, not isolated
host-only costs. Allocator reuse, JIT and measurement RPCs can affect signed
deltas; use repeated process-level samples and heap snapshots to infer leaks.

| Size | Implementation |                    Mean |         p50 |         p99 |        p999 | Ops/s |    RME | Reference / this | Status                                                                                                                                       |
| ---: | -------------- | ----------------------: | ----------: | ----------: | ----------: | ----: | -----: | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | in-process     |  194781.333 bytes/entry |  225216.000 |  263616.320 |  264321.632 |     — | 113.3% |                — | noisy                                                                                                                                        |
|    1 | remote-local   | 1219146.667 bytes/entry |  868616.000 | 2042522.720 | 2064084.272 |     — | 150.3% |                — | noisy                                                                                                                                        |
|    1 | remote-worker  | 1161965.333 bytes/entry |  846048.000 | 1921986.080 | 1941748.208 |     — | 145.7% |                — | noisy                                                                                                                                        |
|    1 | remote-unix    | 2136488.000 bytes/entry | 1576856.000 | 3414748.000 | 3448505.200 |     — | 133.0% |                — | noisy                                                                                                                                        |
|    1 | remote-ws      | 2145826.667 bytes/entry | 1593104.000 | 3430078.720 | 3463819.072 |     — | 133.1% |                — | noisy                                                                                                                                        |
|    1 | raw-worker     |                       — |           — |           — |           — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|    1 | raw-ipc        |                       — |           — |           — |           — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|   10 | in-process     |  104213.333 bytes/entry |   89731.200 |  135722.208 |  136566.941 |     — |  67.1% |                — | noisy                                                                                                                                        |
|   10 | remote-local   |  659575.200 bytes/entry |  552934.400 |  870456.752 |  876288.795 |     — |  70.9% |                — | noisy                                                                                                                                        |
|   10 | remote-worker  |  609846.933 bytes/entry |  509124.800 |  815822.464 |  821455.686 |     — |  74.9% |                — | noisy                                                                                                                                        |
|   10 | remote-unix    | 1285302.933 bytes/entry | 1144453.600 | 1590883.584 | 1599083.318 |     — |  52.8% |                — | noisy                                                                                                                                        |
|   10 | remote-ws      | 1287585.333 bytes/entry | 1146720.000 | 1595763.056 | 1604010.786 |     — |  53.1% |                — | noisy                                                                                                                                        |
|   10 | raw-worker     |                       — |           — |           — |           — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|   10 | raw-ipc        |                       — |           — |           — |           — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|   50 | in-process     |   89573.653 bytes/entry |   84806.240 |   99632.464 |   99904.782 |     — |  24.9% |                — | noisy                                                                                                                                        |
|   50 | remote-local   |  551195.093 bytes/entry |  544196.640 |  625196.384 |  626684.134 |     — |  32.6% |                — | noisy                                                                                                                                        |
|   50 | remote-worker  |  506719.200 bytes/entry |  490884.160 |  575464.589 |  577018.107 |     — |  31.4% |                — | noisy                                                                                                                                        |
|   50 | remote-unix    | 1260697.973 bytes/entry | 1230890.720 | 1329487.971 | 1331298.941 |     — |  12.1% |                — | noisy                                                                                                                                        |
|   50 | remote-ws      | 1263234.080 bytes/entry | 1234346.880 | 1332598.387 | 1334403.007 |     — |  12.2% |                — | noisy                                                                                                                                        |
|   50 | raw-worker     |                       — |           — |           — |           — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|   50 | raw-ipc        |                       — |           — |           — |           — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |

Sequential startup observed in the same R7 samples:

|   N | Connection    |  Mean, ms |       p50 |       p99 | Ops/s (start N) |   RME |
| --: | ------------- | --------: | --------: | --------: | --------------: | ----: |
|   1 | in-process    |     3.399 |     2.814 |     4.882 |         294.162 | 97.3% |
|   1 | remote-local  |   863.608 |   859.694 |   899.937 |           1.158 | 10.2% |
|   1 | remote-worker |   780.257 |   809.224 |   836.853 |           1.282 | 24.2% |
|   1 | remote-unix   |  1558.117 |  1594.829 |  1614.094 |           0.642 | 12.9% |
|   1 | remote-ws     |  1525.205 |  1507.503 |  1571.130 |           0.656 |  6.7% |
|  10 | in-process    |    16.483 |    15.704 |    21.369 |          60.670 | 70.3% |
|  10 | remote-local  |  8601.424 |  8514.729 |  8786.060 |           0.116 |  4.8% |
|  10 | remote-worker |  7358.566 |  7344.448 |  7657.820 |           0.136 | 10.1% |
|  10 | remote-unix   | 14487.773 | 14506.898 | 14511.725 |           0.069 |  0.6% |
|  10 | remote-ws     | 14601.476 | 14611.640 | 14687.488 |           0.068 |  1.6% |
|  50 | in-process    |    69.853 |    62.595 |    84.348 |          14.316 | 46.0% |
|  50 | remote-local  | 42483.943 | 42311.924 | 43018.920 |           0.024 |  2.8% |
|  50 | remote-worker | 39260.888 | 39516.867 | 39592.732 |           0.025 |  3.2% |
|  50 | remote-unix   | 78447.818 | 78346.642 | 79209.749 |           0.013 |  2.3% |
|  50 | remote-ws     | 78722.475 | 78670.490 | 79581.274 |           0.013 |  2.7% |

Startup and native memory observations (RSS and heap in MiB; child RSS is an
absolute per-process value, host deltas are signed):

|   N | Connection    | Start N, ms | Host heap/entry | Host RSS delta/entry | Child RSS/process | Isolate heap |
| --: | ------------- | ----------: | --------------: | -------------------: | ----------------: | -----------: |
|   1 | in-process    |       3.399 |           0.186 |                0.083 |               N/A |       36.456 |
|   1 | remote-local  |     863.608 |           1.163 |                0.542 |           163.164 |       52.093 |
|   1 | remote-worker |     780.257 |           1.108 |               38.809 |               N/A |       46.483 |
|   1 | remote-unix   |    1558.117 |           2.038 |                0.878 |           236.678 |       55.307 |
|   1 | remote-ws     |    1525.205 |           2.046 |                0.833 |           236.986 |       55.026 |
|  10 | in-process    |      16.483 |           0.099 |                0.029 |               N/A |       37.597 |
|  10 | remote-local  |    8601.424 |           0.629 |                0.537 |           163.986 |       53.018 |
|  10 | remote-worker |    7358.566 |           0.582 |               38.453 |               N/A |       41.595 |
|  10 | remote-unix   |   14487.773 |           1.226 |                0.966 |           237.221 |       53.385 |
|  10 | remote-ws     |   14601.476 |           1.228 |                0.507 |           237.089 |       54.111 |
|  50 | in-process    |      69.853 |           0.085 |                0.072 |               N/A |       41.294 |
|  50 | remote-local  |   42483.943 |           0.526 |                0.075 |           164.111 |       52.838 |
|  50 | remote-worker |   39260.888 |           0.483 |               37.478 |               N/A |       41.723 |
|  50 | remote-unix   |   78447.818 |           1.202 |                0.665 |           236.691 |       53.257 |
|  50 | remote-ws     |   78722.475 |           1.205 |                0.702 |           236.862 |       53.196 |

Individual worker RSS is N/A because all workers share process RSS. Host RSS
delta/entry is only an aggregate estimate. Runner heap/RSS observations are a
combined host+runner substitute because the loopback server runs in the same
process. Each full-run footprint/startup point has three independent roots; RME
on the main heap table exposes its uncertainty. These measurements do not
establish a leak.

## remote-r9-logs

Substitute measurement: logging plus verified graceful stop/log drain, with a
zero-log control. 100 logs are paced at 1 ms; larger counts are bursts. Report
actual production rate, received count, warning count and dropped-count
annotations. The host logger counts synchronously without console/disk I/O.
Runner host-thread CPU includes the embedded runner server. A slower real log
sink may drop sooner; no universal threshold is inferred.

|   Size | Implementation |     Mean |      p50 |      p99 |     p999 | Ops/s |    RME | Reference / this | Status                                                                                                                                       |
| -----: | -------------- | -------: | -------: | -------: | -------: | ----: | -----: | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------- |
|      0 | in-process     |    2.089 |    1.531 |    4.411 |    4.517 |   479 |  93.1% |                — | noisy                                                                                                                                        |
|      0 | remote-local   |   50.565 |   53.184 |   62.120 |   62.403 |    20 |  25.8% |          0.0413× | noisy                                                                                                                                        |
|      0 | remote-worker  |   27.958 |   23.510 |   43.340 |   43.953 |    36 |  46.7% |          0.0747× | noisy                                                                                                                                        |
|      0 | remote-unix    |   82.743 |   81.682 |   90.219 |   90.517 |    12 |   7.9% |          0.0252× | noisy                                                                                                                                        |
|      0 | remote-ws      |   82.587 |   77.643 |   98.190 |   98.672 |    12 |  17.0% |          0.0253× | noisy                                                                                                                                        |
|      0 | raw-worker     |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|      0 | raw-ipc        |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|    100 | in-process     |  114.539 |  114.558 |  117.648 |  117.752 |     9 |   3.0% |                — | ok                                                                                                                                           |
|    100 | remote-local   |  164.106 |  161.085 |  176.257 |  176.429 |     6 |   8.3% |           0.698× | noisy                                                                                                                                        |
|    100 | remote-worker  |  133.471 |  134.773 |  136.268 |  136.268 |     7 |   3.6% |           0.858× | ok                                                                                                                                           |
|    100 | remote-unix    |  207.263 |  204.572 |  216.963 |  217.312 |     5 |   4.1% |           0.553× | ok                                                                                                                                           |
|    100 | remote-ws      |  219.546 |  218.681 |  232.440 |  232.719 |     5 |   6.2% |           0.522× | noisy                                                                                                                                        |
|    100 | raw-worker     |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|    100 | raw-ipc        |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|  10000 | in-process     |   12.896 |    7.782 |   31.859 |   32.600 |    78 | 125.1% |                — | noisy                                                                                                                                        |
|  10000 | remote-local   |  217.022 |  215.734 |  236.093 |  236.841 |     5 |   8.1% |          0.0594× | noisy                                                                                                                                        |
|  10000 | remote-worker  |  132.617 |  135.070 |  144.278 |  144.476 |     8 |  10.8% |          0.0972× | noisy                                                                                                                                        |
|  10000 | remote-unix    |  239.733 |  232.043 |  258.084 |  258.488 |     4 |   7.5% |          0.0538× | noisy                                                                                                                                        |
|  10000 | remote-ws      |  247.779 |  238.646 |  282.395 |  283.478 |     4 |  12.6% |          0.0520× | noisy                                                                                                                                        |
|  10000 | raw-worker     |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
|  10000 | raw-ipc        |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
| 100000 | in-process     |   63.792 |   57.162 |  102.932 |  104.610 |    16 |  52.0% |                — | noisy                                                                                                                                        |
| 100000 | remote-local   | 1045.619 | 1027.340 | 1157.973 | 1162.353 |     1 |   9.3% |          0.0610× | noisy                                                                                                                                        |
| 100000 | remote-worker  |  676.101 |  690.395 |  696.930 |  696.974 |     1 |   6.4% |          0.0944× | noisy                                                                                                                                        |
| 100000 | remote-unix    | 1051.592 | 1042.409 | 1152.958 | 1156.308 |     1 |   9.0% |          0.0607× | noisy                                                                                                                                        |
| 100000 | remote-ws      |  985.239 |  979.651 | 1012.026 | 1012.412 |     1 |   3.2% |          0.0647× | ok                                                                                                                                           |
| 100000 | raw-worker     |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |
| 100000 | raw-ipc        |        — |        — |        — |        — |     — |      — |                — | N/A: Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs. |

| Attempts | Connection    | Production rate/s | Received | Dropped | Drop warnings | Warnings/s | Host thread CPU, ms | Drain+stop, ms |
| -------: | ------------- | ----------------: | -------: | ------: | ------------: | ---------: | ------------------: | -------------: |
|        0 | in-process    |                 0 |        0 |       0 |           0.0 |        0.0 |               2.108 |          2.036 |
|        0 | remote-local  |                 0 |        0 |       0 |           0.0 |        0.0 |              13.617 |         47.825 |
|        0 | remote-worker |                 0 |        0 |       0 |           0.0 |        0.0 |              12.666 |         25.446 |
|        0 | remote-unix   |                 0 |        0 |       0 |           0.0 |        0.0 |              25.303 |         79.518 |
|        0 | remote-ws     |                 0 |        0 |       0 |           0.0 |        0.0 |              25.852 |         79.073 |
|      100 | in-process    |               895 |      100 |       0 |           0.0 |        0.0 |               9.476 |          2.770 |
|      100 | remote-local  |               863 |      100 |       0 |           0.0 |        0.0 |              51.571 |         47.913 |
|      100 | remote-worker |               877 |      100 |       0 |           0.0 |        0.0 |              53.595 |         19.395 |
|      100 | remote-unix   |               772 |      100 |       0 |           0.0 |        0.0 |              84.168 |         77.475 |
|      100 | remote-ws     |               762 |      100 |       0 |           0.0 |        0.0 |              89.573 |         87.749 |
|    10000 | in-process    |           1410292 |    10000 |       0 |           0.0 |        0.0 |              12.351 |          2.133 |
|    10000 | remote-local  |             61117 |      512 |    9488 |           4.0 |       18.5 |             106.787 |         52.915 |
|    10000 | remote-worker |             93600 |      384 |    9616 |           3.0 |       22.7 |              52.928 |         25.277 |
|    10000 | remote-unix   |             66511 |      384 |    9616 |           3.0 |       12.5 |             120.140 |         89.098 |
|    10000 | remote-ws     |             64178 |      384 |    9616 |           3.0 |       12.2 |             123.224 |         90.427 |
|   100000 | in-process    |           1753341 |   100000 |       0 |           0.0 |        0.0 |              62.573 |          2.232 |
|   100000 | remote-local  |            101391 |     3302 |   96698 |          25.8 |       24.7 |             688.973 |         56.275 |
|   100000 | remote-worker |            153597 |     2637 |   97363 |          20.6 |       30.5 |             307.929 |         23.928 |
|   100000 | remote-unix   |            104915 |     2278 |   97722 |          17.8 |       17.0 |             701.147 |         95.504 |
|   100000 | remote-ws     |            111665 |     2304 |   97696 |          18.0 |       18.3 |             695.335 |         89.280 |

Counts and rates are means of repetitions. Received + dropped equals attempts in
every repetition. Main timing is a substitute: production plus verified
drain/stop, with a zero-log control. Host thread CPU uses
process.threadCpuUsage; companion process.cpuUsage data in JSON includes worker
execution. Runner thread CPU is a combined host+runner substitute. Native
console formatting is part of Remote's default child runtime.

## Execution ownership audit

Verified native exits: 3164. Leftover processes before cleanup: 0; after
cleanup: 0. Ownership token: 4652a0a8-d009-41c4-a3d3-76c5ab189108.
