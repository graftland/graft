export const remoteImplementations = [
	"in-process",
	"remote-local",
	"remote-worker",
	"remote-unix",
	"remote-ws",
	"raw-worker",
	"raw-ipc",
]
export const remoteCases = (quick = false) => [
	...[
		"remote-r1-start",
		"remote-r1-stop",
		"remote-r2-call",
		"remote-r5-stream",
		"remote-r6-config",
		"remote-r8-loop",
		"remote-r10-failure",
	].map((scenario) => ({
		scenario,
		size: scenario === "remote-r5-stream" ? 100 : 1,
		calls: 1,
	})),
	...[1, 16, 256].map((size) => ({
		scenario: "remote-r3-throughput",
		size,
		calls: 256,
	})),
	{ scenario: "remote-r3-batch", size: 256, calls: 256 },
	...[100, 10000, 1000000, 1048576, 1048577].map((size) => ({
		scenario: "remote-r4-payload",
		size,
		calls: 1,
	})),
	...(quick ? [1] : [1, 10, 50]).flatMap((size) =>
		["remote-r7-footprint"].map((scenario) => ({
			scenario,
			size,
			calls: 1,
		})),
	),
	...[0, 100, 10000, 100000].map((size) => ({
		scenario: "remote-r9-logs",
		size,
		calls: 1,
	})),
]
export const remoteSupported = (implementation, scenario) => {
	if (!remoteImplementations.includes(implementation))
		return "This implementation has no Remote contract or connection adapter."
	if (
		implementation.startsWith("raw-") &&
		![
			"remote-r2-call",
			"remote-r3-throughput",
			"remote-r3-batch",
			"remote-r4-payload",
		].includes(scenario)
	)
		return "Raw Node transport supplies only the echo round-trip baseline; it has no plugin lifecycle, contract streams, config, or forwarded logs."
	if (implementation === "in-process" && scenario === "remote-r10-failure")
		return "process.exit terminates the whole host. A separate crash witness verifies this; no surviving fork can reach Failed or stop a consumer."
	return null
}
export const remoteMethodology = {
	full: {
		lifecycleSamples: 20,
		warmup: 3,
		callSamples: 5000,
		callWarmup: 500,
		batchSamples: 30,
		specialSamples: 5,
		boundarySamples: 3,
		footprintSamples: 3,
	},
	quick: {
		lifecycleSamples: 2,
		warmup: 1,
		callSamples: 10,
		callWarmup: 2,
		batchSamples: 2,
		specialSamples: 2,
		boundarySamples: 2,
		footprintSamples: 2,
	},
	cpuIterations: 50000000,
	monitorResolutionMs: 1,
	unrelatedDelayMs: 5,
	histogramPrimeMs: 20,
	failureDeadlineMs: 30000,
	footprintTimeoutMs: 900000,
	framePayloadLimitBytes: 1048576,
	gcPasses: 3,
}
export const remoteInterpretation = {
	"remote-r1-start":
		"Entry loading through an actual consumer's first echo and identity reply. Runner server/listener readiness is prepared outside timing. Remote includes public assembly, config validation, process/module startup, contract negotiation and proxy publication. Compare repeated processes or disabled module caches to distinguish startup sources.",
	"remote-r1-stop":
		"Entry disposal through native child exit or Worker exit, then consumer settlement. Scope teardown is outside timing. Channel closure alone is insufficient. Grace periods and log draining can explain gaps; inspect native exit records and cleanup causes before assigning transport cost.",
	"remote-r2-call":
		"One awaited tiny echo per sample through the same consumer service. p999 is empirical: 5000 full-run calls provide only about five observations in its upper 0.1%. Raw worker uses structured clone; raw IPC uses Node's default JSON serialization. Differences include Effect RPC, Schema, framing, copies and scheduling, so subtraction is an aggregate overhead estimate, not pure framing cost.",
	"remote-r3-throughput":
		"256 completed echoes per batch, bounded to 1, 16 or 256 in flight. The remote data admission default is 16 per direction, so 256 submitted requests may queue. Confirm all sequence numbers and final call count. A larger payload, different admission settings or multiple producer processes could change the ranking.",
	"remote-r3-batch":
		"256 identical echo operations in one batch contract call; compares with 256 unary calls. All sequence numbers, results and service call counts must match. Batching changes API granularity and the number of host runPromise bridges, so it demonstrates whole-call amortization rather than framing alone. A real workload needing streaming/early results may prefer smaller batches.",
	"remote-r4-payload":
		"ASCII request/response text of exactly the displayed byte length. Runner framing limits protocol payload to 1 MiB, including its JSON envelope; a 1 MiB business string is larger than a valid frame. Direct local/worker paths are tested independently. Rejections are boundary outcomes, never treated as successful throughput or compared with successful calls. Different string contents and codec shapes change the serialized size.",
	"remote-r5-stream":
		"A supported Rpc stream emits exactly 0..99; timing ends after stream completion. Chunking/backpressure differs from eager in-process iteration. Larger chunks or demand-driven consumers could reverse a result; streams are not equivalent to 100 independent unary calls.",
	"remote-r6-config":
		"An in-process updater keeps its service and consumer active; Remote restarts the execution and consumer. Timing ends after the consumer can call the new value, and the old execution has really exited. This is intentionally a semantic comparison; restart counts differ as documented and tested.",
	"remote-r7-footprint":
		"Post-GC host heap delta divided by entries, plus process RSS and isolate heap observations, at 1/10/50 entries in one Graft root with separate Api realms. Worker RSS is process-wide: only total host RSS delta per entry is an estimate, not individual worker RSS. Runner substitute: per-entry host heap/RSS and CPU include the embedded runner server's session bookkeeping; server setup itself is outside the baseline. These are combined host+runner costs, not isolated host-only costs. Allocator reuse, JIT and measurement RPCs can affect signed deltas; use repeated process-level samples and heap snapshots to infer leaks.",
	"remote-r7-start":
		"Sequentially start N isolated entries and wait for each consumer to complete its first echo. This is aggregate startup, not a parallel-start saturation test. Runner server creation is outside timing. A production parallel-start policy needs a separate measurement.",
	"remote-r8-loop":
		"The identical fixed integer CPU loop runs behind the service. A reverse notice schedules an unrelated in-process service call for 5 ms later; reported latency includes timer delay until that call completes. monitorEventLoopDelay is primed before and drained after work. Transport round trips and spare CPU capacity matter; a saturated CPU or a larger/smaller loop could change the worker/local trade-off.",
	"remote-r9-logs":
		"Substitute measurement: logging plus verified graceful stop/log drain, with a zero-log control. 100 logs are paced at 1 ms; larger counts are bursts. Report actual production rate, received count, warning count and dropped-count annotations. The host logger counts synchronously without console/disk I/O. Runner host-thread CPU includes the embedded runner server. A slower real log sink may drop sooner; no universal threshold is inferred.",
	"remote-r10-failure":
		"Intentional process.exit(73), after an acknowledged reverse notice. Primary clock is host notice receipt immediately before the exit request, not the unobservable exact OS exit instant; also record native exit-event to Failed and consumer stop timestamps, which may be negative if protocol failure is detected before the native exit callback. Crash causes are retained. Other failure types and runner lease expiry need separate measurements.",
}
