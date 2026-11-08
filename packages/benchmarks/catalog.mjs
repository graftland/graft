export const implementations = [
	"graft",
	"cordis",
	"avvio",
	"effect",
	"node",
	"emittery",
]
export const imports = {
	graft: "@graftland/graft",
	cordis: "cordis",
	avvio: "avvio",
	effect: "effect",
	node: "node:events",
	emittery: "emittery",
}
export const cases = (quick = false) => {
	const rows = []
	const add = (scenario, sizes, calls = 1) => {
		for (const size of sizes) rows.push({ scenario, size, calls })
	}
	for (const scenario of [
		"cold-load",
		"cold-dispose",
		"fanout-load",
		"fanout-withdraw",
		"fanout-restore",
	])
		add(scenario, [1, 100, 1000])
	add("chain", [1, 10, 100])
	add("service", [1], quick ? 100 : 10000)
	for (const mode of [
		"emit",
		"sequential",
		"parallel",
		"bail",
		"serial-bail",
		"waterfall",
	])
		add(`events-${mode}`, [1, 10, 100], quick ? 2 : 100)
	for (const scenario of ["config-update", "config-restart"]) add(scenario, [1])
	add("memory-cycles", [10])
	add("memory-steady", [1000])
	add("import", [1])
	return rows
}
export const methodology = {
	full: {
		time: 2000,
		iterations: 100,
		warmupTime: 1000,
		warmupIterations: 20,
		memorySamples: 20,
		cycles: 100,
		importSamples: 400,
		importWarmup: 3,
		precisionTargetRme: 4,
		maxMeasuredTime: 24000,
		maxWallTime: 480000,
	},
	quick: {
		time: 0,
		iterations: 3,
		warmupTime: 0,
		warmupIterations: 1,
		memorySamples: 3,
		cycles: 5,
		importSamples: 3,
		importWarmup: 1,
	},
	targetRme: 5,
	confidence: 0.95,
	workerTimeoutMs: 600000,
	gcPasses: 3,
}
export const interpretation = {
	"cold-load":
		"Independent plugin activation, excluding root construction and definition imports. Graft supervises scopes and transactions; cordis uses context proxies; avvio orders a boot queue; raw Effect builds one scoped Layer per resource. An allocation profile or an equal scheduling policy could change attribution.",
	"cold-dispose":
		"Dispose the already active plugins, awaiting every finalizer. Avvio closes the whole loader (substitute: no individual runtime unload). Graft retains dependency and failure guarantees even without dependencies here. Reverse-order or parallel cleanup policy and allocation profiles could explain gaps.",
	"fanout-load":
		"Load one provider and N consumers, each calling the provider once. Avvio uses ordered registration and a typed application property (manual wiring, no reactive dependency graph). Raw Effect wires a Context manually. Profiles with equivalent graph validation could change overhead attribution.",
	"fanout-withdraw":
		"Withdraw one provider and wait for all N consumer finalizers and Pending states. Raw Effect explicitly closes consumer scopes first (manual orchestration substitute). Graft leases and cordis dependency tracking add work; profiling dependency scans versus transactions could change the explanation.",
	"fanout-restore":
		"Restore the provider and wait for N consumer activations and calls. Raw Effect explicitly rebuilds the consumer layers (manual orchestration substitute). Fresh activation scopes, graph notification and Graft transactions may explain gaps; a trace separating graph work from scheduling would change that inference.",
	chain:
		"Build and activate D service-linked plugins in topological order, reading each predecessor once. Avvio uses manual ordered properties; Effect accumulates Context layers. This does not measure resolving a reverse-registered graph. Reverse-order registration and a graph profile would change conclusions about dependency scheduling.",
	service:
		"A dependent performs 10000 lookups and synchronous method calls, accumulating a checksum. Graft and Effect yield a Context service on each call; cordis uses its proxy and avvio an application property. Profiles separating Effect interpreter work from lookup work would change the explanation; this is not RPC or an effectful service method.",
	"events-emit":
		"Completed ordered broadcast with synchronous handler bodies. Graft emit, cordis emit, Node/avvio emit, emittery emitSerial and a raw Effect loop all call every handler. Promise and Effect scheduling differ even though the work completes. Graft restores context and owns invocation scopes. Async-body and allocation profiles would change the conclusion.",
	"events-sequential":
		"Awaited ordered broadcast: Graft emit, cordis serial with all handlers returning undefined, emittery emitSerial and a raw Effect loop. Handler bodies are synchronous; this does not establish async I/O throughput. Cordis serial can short-circuit on a value. Async handler and cancellation measurements would change interpretation.",
	"events-parallel":
		"Await all handlers: Graft parallel, cordis parallel, emittery emit, and raw Effect PubSub with one subscription and scoped consumer fiber per handler per dispatch. Discard result arrays consistently. PubSub delivery is a substitute for direct callbacks and includes publish/take/join. A persistent-consumer PubSub design and allocation profiles would change comparisons.",
	"events-bail":
		"Visit H handlers; the last returns 7. Graft uses Option, cordis uses synchronous bail, raw Effect loops manually. This measures worst-case traversal, not early exit. Moving the answer to the first handler and profiling invocation scopes would change conclusions.",
	"events-serial-bail":
		"Awaited bail: Graft bail and cordis serial; the last handler returns 7. Cordis bail itself does not await Promises. Raw Effect loops manually. Bodies are synchronous; async suspension and first-handler answers could change conclusions.",
	"events-waterfall":
		"H middleware wrappers add one to the terminal result 0. Graft waterfall supports next(input), while pinned cordis waterfall uses next() with captured arguments. Only output wrapping overlaps; input transformation and repeated next are not compared. Adding context restoration or shared-next semantics to a baseline could change the gap.",
	"config-update":
		"One sequential config update after startup, preserving activation. Graft Schema.Struct decodes Schema.Int; cordis uses an internal/update hook and no optional Config schema; raw Effect assigns a value manually. This is a default-validation comparison. Equal schema validation could change the gap.",
	"config-restart":
		"Change config and await teardown and a second activation. Graft decodes the same integer schema; cordis uses update without an update hook; raw Effect closes/rebuilds a scope manually. Schema, queueing and restart profiles could change attribution.",
	"memory-cycles":
		"Retained heap growth after M cycles of 10 plugins inside one persistent root, after warmup and forced GC. Report bytes per batch and slope across checkpoints, including negative noise. Avvio has no runtime unload. A repeatable positive slope over larger M and heap snapshots would support a leak claim; one positive delta does not.",
	"memory-steady":
		"Forced-GC heap delta for 1000 live independent plugins relative to an empty root, divided by N. Includes plugin handles and framework bookkeeping, excludes import/root cost. JIT and GC noise remain. Repeated process-level deltas and heap dominator analysis would change attribution.",
	import:
		"Fresh-process dynamic import latency measured inside Node, including dependency evaluation and excluding process launch. A second metric records process wall time. Every sample gets a new process; there is no module-cache warmup. Filesystem cache is warm and uncontrolled. Node EventEmitter is a built-in module; its import can reuse bootstrap initialization and is not a cold userland initialization measurement. Cold-cache runs or dependency import traces would change interpretation.",
}
