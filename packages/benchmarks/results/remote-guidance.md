# Remote guidance from the canonical benchmark run

Measured on v26.12.1, AMD EPYC-Genoa Processor (16 logical CPUs), linux 6.18.56.
Git `c5055a7f237e3900b4ae6348ce1bc92145f644a4`; dirty suite SHA-256
`141a2cb8544c0e67ed7af230cea92a41868826a0364d70116da079466c582acd`.

This machine and workload produced 295 measurements and 136 explicit N/A cells.
Full runner wall: **4772.3 s**. Native audit: **3164 exits**, **0 leftovers
before cleanup**, **0 afterward**. No forced cleanup was needed.

**Precision:** 0/154 original timing rows exceed 5% RME; 101/295 measured rows
overall remain noisy. Original timing continuation retains every sample and
capped outcome within one full run. Remote fixed budgets are unchanged. Repeated
precision checks make original nominal 95% intervals descriptive, not sequential
confidence guarantees. RME, sample counts and caps stay visible. Remote p999
uses 5000 calls, only about five upper-tail observations; it is not a production
tail guarantee.

Primary data: [JSON](latest.json), [comparison tables](latest.md),
[sources/defaults](../SOURCES.md). Raw sample files are linked under ignored
cache. No docs-site source was edited.

## Claims and proposed wording

| Claim and guide section                                                                                                                                                 | Measured evidence                                                                                                                                                                                                                                               | Verdict and proposed concrete change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production, [Contain failures](../../docs/content/docs/best-practices/production.md#contain-failures): local contains failures; worker protects the event loop.         | Controlled process.exit(73) leaves the Remote host alive and stops its consumer. R8 unrelated timer-inclusive call: in-process 55.64 ms, remote-local 5.69 ms, remote-worker 5.62 ms, remote-unix 5.40 ms, remote-ws 4.87 ms.                                   | Confirmed for this exit and fixed CPU loop. Add: “Use a long-lived worker for CPU work when host responsiveness matters. Local processes also protect the host event loop and provide a process boundary. Choose the boundary using failure behavior, startup and memory.” Native faults/OOM/hangs were not tested.                                                                                                                                                                                                                                                 |
| Production: runners execute on other machines. [Runners](../../docs/content/docs/remote/runners.md).                                                                    | Real Unix/loopback WebSocket transports execute separate plugin PIDs; the runner server is embedded in the benchmark host.                                                                                                                                      | Functional capability exercised locally; WAN/TLS/authentication performance unmeasured. Add: “Measure the real network path before moving a latency-sensitive publisher to a runner.”                                                                                                                                                                                                                                                                                                                                                                               |
| [Design](../../docs/content/docs/best-practices/design.md), contract table near line 27, migration guidance near 260 and weather example near 280: unchanged consumers. | The same injected consumer produces matching text, batch, stream, config-value and CPU results. Sequence values verify per-execution call counts; Remote restart intentionally resets them. Lifecycle and performance costs differ.                             | API transparency holds for this wireable Effect contract; execution state and lifetime differ. After the table add: “Consumers can keep the same service API, but remote calls serialize data and cross a connection. Keep inner loops local, or expose coarse operations and batches. Remote config changes restart the publisher, reset execution-local state and stop its dependents.” In the weather example add: “Cache or batch city forecasts at the publisher; avoid one RPC per field or collection element.” HTTP/weather workload cost was not measured. |
| [Observability](../../docs/content/docs/best-practices/observability.md), Remote logging near line 188: logs may drop.                                                  | Paced and burst counts below; remote-local: 96672–96800/100000 dropped; remote-worker: 97312–97440/100000 dropped; remote-unix: 97696–97824/100000 dropped; remote-ws: 97696/100000 dropped. Every repetition balances delivered+dropped=attempted after drain. | Add: “Remote forwarding is best effort, not an audit log. Sample or aggregate frequent messages at the publisher. Monitor remote.logs.dropped and remote.logs.droppedTotal, not only warning-line count. Keep durable audit records in a storage service.” These rates are not universal thresholds.                                                                                                                                                                                                                                                                |
| [Overview](../../docs/content/docs/remote/overview.md): “Each call is a message.”                                                                                       | Unary costs exceed raw transport baselines; the same 256 leaf operations are faster in one contract batch than 256 unary calls.                                                                                                                                 | Supported as a call-boundary cost. Replace with: “Each unary call performs request/response RPC; even a trivial method serializes data and crosses the connection. Batch related operations when the API permits it. A stream may send multiple messages.” A logical call is not one physical packet.                                                                                                                                                                                                                                                               |

## Lifecycle and config costs

| Connection    | Start + readiness/identity, ms | Stop through native exit, ms | Config update/restart, ms |
| ------------- | ------------------------------ | ---------------------------- | ------------------------- |
| in-process    | 2.67                           | 1.03                         | 1.08                      |
| remote-local  | 866.76                         | 43.71                        | 886.99                    |
| remote-worker | 698.80                         | 21.00                        | 705.36                    |
| remote-unix   | 1462.67                        | 75.01                        | 1509.30                   |
| remote-ws     | 1459.62                        | 76.66                        | 1528.99                   |

Start includes public definition/assembly, consumer readiness echo and identity
reply. Shared runner/listener setup is outside timing. Stop includes actual
native exit and consumer settlement. In-process updates preserve execution;
Remote updates fully restart it. Both paths make the same two validation echoes.
Effect interruption-only child teardown can exit 130, so success requires Graft
disposal, finalizers and observed native exit, rather than code zero alone.
Sources: [execution](../../plugin-remote/src/internal/execution.ts),
[native observation](../remote-native.mjs),
[Effect Runtime](../../../node_modules/effect/src/Runtime.ts).

**Inference:** keep entries long-lived. Per-request creation and frequent config
changes can cost much more than a short method. Module graphs, bundling, Schema,
filesystem caches and hardware could change startup; this does not isolate
parsing from framework setup.

## Calls, concurrency and batching

| Connection    | Unary mean, ms | p50    | p99    | p999   | Mean RME |
| ------------- | -------------- | ------ | ------ | ------ | -------- |
| in-process    | 0.0068         | 0.0036 | 0.0272 | 0.0697 | 31.6%    |
| remote-local  | 0.6261         | 0.5761 | 2.4675 | 3.6948 | 1.3%     |
| remote-worker | 0.5678         | 0.5241 | 2.2348 | 3.7010 | 1.4%     |
| remote-unix   | 1.1948         | 1.0959 | 3.7596 | 6.4467 | 1.3%     |
| remote-ws     | 1.3457         | 1.2193 | 4.0542 | 7.2869 | 1.2%     |
| raw-worker    | 0.0276         | 0.0239 | 0.0518 | 0.1791 | 7.6%     |
| raw-ipc       | 0.0512         | 0.0434 | 0.1207 | 0.3962 | 3.6%     |

**Measured Remote overhead over the selected raw baselines:** worker unary p50
**0.5241 ms versus raw-worker 0.0239 ms (21.9×, +0.5002 ms)**; local unary p50
**0.5761 ms versus raw-ipc 0.0434 ms (13.3×, +0.5327 ms)**. These are measured
latency differences, not isolated framing costs: Schema, Effect RPC, copies,
invocation ownership, scheduling and different transport plumbing all
contribute. Medians do not make noisy mean ratios precise.

| Connection    | 256 unary C=1, ms | C=16   | C=256  | One 256-item batch, ms | Serial/batch mean ratio |
| ------------- | ----------------- | ------ | ------ | ---------------------- | ----------------------- |
| in-process    | 1.70              | 1.56   | 2.00   | 0.43                   | 3.9×                    |
| remote-local  | 165.01            | 57.09  | 61.16  | 3.41                   | 48.4×                   |
| remote-worker | 156.84            | 53.99  | 57.75  | 3.27                   | 47.9×                   |
| remote-unix   | 301.01            | 156.96 | 168.29 | 4.95                   | 60.8×                   |
| remote-ws     | 332.67            | 180.52 | 184.85 | 5.23                   | 63.6×                   |
| raw-worker    | 8.52              | 1.39   | 1.41   | 0.24                   | 35.5×                   |
| raw-ipc       | 10.75             | 1.59   | 1.70   | 0.34                   | 32.0×                   |

Batches return the same 256 ordered echo results and service-operation count.
They intentionally use fewer host execution bridges and RPC calls. Submitted
concurrency is not admitted concurrency: the default data admission limit is 16
per direction. Across the four Remote connections, C=256 means remain slightly
higher than C=16 means, with similar completion times. **Inference:** bound
application concurrency and measure saturation; do not assume 16 is universally
optimal. Batch suitable work before increasing in-flight counts. Equal-codec
transport experiments and CPU/allocation profiles could change attribution.
Sources: [contract](../src/remote-contract.ts),
[limits](../../plugin-remote/src/internal/Limits.ts),
[Port](../../plugin-remote/src/internal/port.ts),
[worker channel](../../plugin-remote/src/internal/workerChannel.ts).

## Payload and streams

R4 echoes the same ASCII text in request and response. At decimal 1 MB:
remote-local 7.87 ms (RME 15.1%), remote-worker 7.89 ms (RME 15.3%), remote-unix
18.13 ms (RME 14.1%), remote-ws 18.54 ms (RME 12.5%). Runner frame payload is
**1048576 bytes** with an **8-byte header**; JSON envelopes consume payload
space. Full calls with 1048576- and 1048577-byte business strings are separately
classified as rejected at runner boundaries, with cleanup causes retained and no
successful-call throughput. The independent oracle accepts an exact-limit
protocol frame and rejects limit+1. Direct local/worker and raw channels use
different paths, tested separately. WebSocket compression is disabled. Sources:
[Framing](../../plugin-remote/src/internal/runner/Framing.ts),
[WebSocket settings](../../plugin-remote/src/internal/websocketServer.ts),
[direct channels](../../plugin-remote/src/internal/childRuntime.ts).

R5 completes the supported stream 0..99: in-process 0.04 ms (RME 16.2%),
remote-local 3.08 ms (RME 16.9%), remote-worker 3.37 ms (RME 18.5%), remote-unix
6.54 ms (RME 17.5%), remote-ws 5.28 ms (RME 13.8%). Chunking/backpressure differ
from 100 unary calls. Proposed Design contract wording: “Bound batches by
encoded bytes as well as item count. Leave envelope headroom below the runner
frame limit. Use supported streams for demand-driven sequences, and measure
chunk sizes.” Different codecs, string contents and demand can change scaling.

## Footprint and scale

| N   | Connection    | Host heap/entry, MiB | Heap RME | Host RSS delta/entry, MiB | Plugin PID RSS, MiB | Sequential start N, s | Startup RME |
| --- | ------------- | -------------------- | -------- | ------------------------- | ------------------- | --------------------- | ----------- |
| 1   | in-process    | 0.186                | 113.3%   | 0.083                     | N/A                 | 0.00                  | 97.3%       |
| 1   | remote-local  | 1.163                | 150.3%   | 0.542                     | 163.2               | 0.86                  | 10.2%       |
| 1   | remote-worker | 1.108                | 145.7%   | 38.809                    | N/A                 | 0.78                  | 24.2%       |
| 1   | remote-unix   | 2.038                | 133.0%   | 0.878                     | 236.7               | 1.56                  | 12.9%       |
| 1   | remote-ws     | 2.046                | 133.1%   | 0.833                     | 237.0               | 1.53                  | 6.7%        |
| 10  | in-process    | 0.099                | 67.1%    | 0.029                     | N/A                 | 0.02                  | 70.3%       |
| 10  | remote-local  | 0.629                | 70.9%    | 0.537                     | 164.0               | 8.60                  | 4.8%        |
| 10  | remote-worker | 0.582                | 74.9%    | 38.453                    | N/A                 | 7.36                  | 10.1%       |
| 10  | remote-unix   | 1.226                | 52.8%    | 0.966                     | 237.2               | 14.49                 | 0.6%        |
| 10  | remote-ws     | 1.228                | 53.1%    | 0.507                     | 237.1               | 14.60                 | 1.6%        |
| 50  | in-process    | 0.085                | 24.9%    | 0.072                     | N/A                 | 0.07                  | 46.0%       |
| 50  | remote-local  | 0.526                | 32.6%    | 0.075                     | 164.1               | 42.48                 | 2.8%        |
| 50  | remote-worker | 0.483                | 31.4%    | 37.478                    | N/A                 | 39.26                 | 3.2%        |
| 50  | remote-unix   | 1.202                | 12.1%    | 0.665                     | 236.7               | 78.45                 | 2.3%        |
| 50  | remote-ws     | 1.205                | 12.2%    | 0.702                     | 236.9               | 78.72                 | 2.7%        |

Runner host heap/RSS/CPU are a **combined host+embedded-runner substitute**.
Host retained heap includes the consumer, fixture and native-exit auditor
bookkeeping; it is not a library-only allocation count. Child RSS is absolute
resident memory and can double-count shared pages; it is not exclusive physical
memory. Runner plugin PID RSS includes its watchdog worker:
[Watchdog](../../plugin-remote/src/internal/runner/Watchdog.ts),
[watchdog entry](../../plugin-remote/src/internal/watchdogMain.ts). Individual
worker RSS is N/A because workers share process RSS. Host RSS delta/N is an
aggregate estimate; isolate heap is an uncollected snapshot. Only host retained
heap follows explicit GC. Three footprint repetitions are noisy; no leak is
established.

**Inference:** budget isolation per entry. These starts are sequential, not
parallel saturation. Group related operations into a publisher when its failure
boundary permits it. Measure PSS/exclusive memory and steady workloads before
choosing production limits. Independent runner servers, heap dominators, more
process repetitions and parallel startup could change this conclusion.

## Event-loop protection and failures

| Connection    | CPU call mean, ms | CPU-call RME | Mean burst p99 loop delay, ms | Worst loop stall, ms | Unrelated call incl. 5 ms timer, ms |
| ------------- | ----------------- | ------------ | ----------------------------- | -------------------- | ----------------------------------- |
| in-process    | 55.59             | 0.8%         | 56.77                         | 57.25                | 55.64                               |
| remote-local  | 65.37             | 9.0%         | 2.08                          | 2.38                 | 5.69                                |
| remote-worker | 64.00             | 1.9%         | 1.77                          | 3.48                 | 5.62                                |
| remote-unix   | 66.90             | 2.4%         | 1.67                          | 2.57                 | 5.40                                |
| remote-ws     | 64.86             | 1.5%         | 1.67                          | 1.87                 | 4.87                                |

Every connection computes the same 50-million-step checksum. Both local and
worker protect host responsiveness for this workload. The unrelated-call
observation includes its 5 ms timer target. CPU-call RME is shown explicitly;
noisy means should not rank execution speed. Worker process.exit terminates its
worker, so it does not prove containment of a native-process crash. Saturation,
native addons, OOM and hangs are unmeasured.

| Connection    | Notice to Failed, ms | Native exit to Failed, ms | Notice to consumer stopped, ms | Mean RME |
| ------------- | -------------------- | ------------------------- | ------------------------------ | -------- |
| remote-local  | 33.35                | 9.81                      | 34.10                          | 32.1%    |
| remote-worker | 14.72                | 9.26                      | 15.46                          | 43.7%    |
| remote-unix   | 65.28                | 26.29                     | 66.13                          | 28.7%    |
| remote-ws     | 58.35                | 23.84                     | 59.07                          | 26.1%    |

The in-process witness exits the whole host with code 73 while its consumer is
active, before finalization. Remote witnesses really exit 73; full causes and
timestamps are retained. The primary clock begins with host receipt of an
acknowledged pre-exit notice, not the exact OS crash instruction. Native
exit-event timing is separate, and a negative interval would be retained.

**Performance finding:** runner native-exit-to-Failed means are remote-unix
26.29 ms and remote-ws 23.84 ms. Both rows are noisy. The runner now pushes a
termination notice; lease renewal remains a fallback:
[host runner](../../plugin-remote/src/internal/host/runner.ts). Proposed
Production health wording: “Remote failure propagation is asynchronous. Include
fork state and remote-call failures in health reporting. Runner termination
notices propagate execution exits; lease renewal provides a fallback. Do not
assume dependents stop at the instant a remote PID exits.” Different network
paths, lease policy or independent runners could change these timings.

## Log forwarding

| Attempts | Connection    | Production attempts/s | Structured delivered | Forwarding drops | Mean warnings | Warnings/s incl. drain | Host thread CPU, ms |
| -------- | ------------- | --------------------- | -------------------- | ---------------- | ------------- | ---------------------- | ------------------- |
| 0        | remote-local  | 0                     | 0                    | 0                | 0.0           | 0.0                    | 13.6                |
| 0        | remote-worker | 0                     | 0                    | 0                | 0.0           | 0.0                    | 12.7                |
| 0        | remote-unix   | 0                     | 0                    | 0                | 0.0           | 0.0                    | 25.3                |
| 0        | remote-ws     | 0                     | 0                    | 0                | 0.0           | 0.0                    | 25.9                |
| 100      | remote-local  | 863                   | 100                  | 0                | 0.0           | 0.0                    | 51.6                |
| 100      | remote-worker | 877                   | 100                  | 0                | 0.0           | 0.0                    | 53.6                |
| 100      | remote-unix   | 772                   | 100                  | 0                | 0.0           | 0.0                    | 84.2                |
| 100      | remote-ws     | 762                   | 100                  | 0                | 0.0           | 0.0                    | 89.6                |
| 10000    | remote-local  | 61117                 | 512                  | 9488             | 4.0           | 18.5                   | 106.8               |
| 10000    | remote-worker | 93600                 | 384                  | 9616             | 3.0           | 22.7                   | 52.9                |
| 10000    | remote-unix   | 66511                 | 384                  | 9616             | 3.0           | 12.5                   | 120.1               |
| 10000    | remote-ws     | 64178                 | 384                  | 9616             | 3.0           | 12.2                   | 123.2               |
| 100000   | remote-local  | 101391                | 3200–3328            | 96672–96800      | 25.8          | 24.7                   | 689.0               |
| 100000   | remote-worker | 153597                | 2560–2688            | 97312–97440      | 20.6          | 30.5                   | 307.9               |
| 100000   | remote-unix   | 104915                | 2176–2304            | 97696–97824      | 17.8          | 17.0                   | 701.1               |
| 100000   | remote-ws     | 111665                | 2304                 | 97696            | 18.0          | 18.3                   | 695.3               |

The 100-log case pauses 1 ms between attempts; larger counts are bursts, not
calibrated production thresholds. Delivered/dropped entries count structured
forwarding records and show repetition ranges when they differ; warning
counts/rates and CPU are means. Every repetition balances
attempted=delivered+dropped after verified drain. Warning lines aggregate
cumulative-drop deltas, so their count does not equal lost-record count. These
counts do not assert that all native formatted console text disappeared; that
side channel is counted separately.

R9 is a **substitute timing**: production plus verified graceful drain and stop.
Zero-log controls remain in the canonical report; do not attribute the whole
interval to logging or subtract noisy controls as a causal estimate. Host CPU
uses process.threadCpuUsage; companion process CPU includes worker execution.
Embedded runner work contributes to host-thread CPU.

The child runtime keeps its default logger while adding structured forwarding.
Both [workerMain](../../plugin-remote/src/internal/workerMain.ts) and
[childMain](../../plugin-remote/src/internal/childMain.ts) explicitly route
native loggers to stderr. The canonical R9 stdout guard recorded zero bytes.
Direct-worker stderr is captured in the result diagnostics; local/runner stderr
follows the bounded ProcessObservation path. Costs therefore include native
formatting and stderr handling as well as structured forwarding. This is not a
terminal/disk/network production exporter; a different sink can change CPU,
backpressure and loss. The forwarding queue is **128 records**, RPC log
admission **2**, while raw-byte/pending queues include unbounded stages.
Sources: [child telemetry](../../plugin-remote/src/internal/child.ts),
[drop annotations](../../plugin-remote/src/internal/host.ts),
[limits](../../plugin-remote/src/internal/Limits.ts),
[Port](../../plugin-remote/src/internal/port.ts).

## Reproduce the findings

Each command uses the same isolated runner and full budgets unless --quick is
supplied. Alternate artifacts stay in ignored cache so the canonical results
remain unchanged.

```sh
devenv shell -- pnpm bench --scenario remote-r2,remote-r3 --output .cache/reproduce-calls
devenv shell -- pnpm bench --scenario remote-r10 --implementation remote-local,remote-worker,remote-unix,remote-ws --output .cache/reproduce-crash
devenv shell -- pnpm bench --scenario remote-r7 --output .cache/reproduce-footprint
devenv shell -- pnpm bench --scenario remote-r4,remote-r9 --output .cache/reproduce-boundaries
```

Measured costs/limits include unary RPC overhead, cold/config restart and
per-entry memory costs, concurrency saturation, burst-log loss and asynchronous
runner death detection. Their internal CPU/allocation causes are not all
isolated. WAN/TLS/authentication, isolated host-only runner accounting, uncaught
throws/native faults/OOM/hangs and parallel-start saturation remain unmeasured.
No core, loader or Remote source was edited.
