import assert from "node:assert/strict"
import { resolve } from "node:path"
import { setImmediate as immediate } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { inspect } from "node:util"

import { Effect } from "effect"

import { Bench } from "tinybench"

import { methodology } from "./catalog.mjs"
import { withCleanup } from "./cleanup.mjs"
import { expected } from "./dist/expectation.js"
import { statistics } from "./statistics.mjs"

export const factoryFor = async (implementation) => {
	const path = {
		graft: "graft",
		cordis: "cordis",
		effect: "baseline",
		avvio: "avvio",
		node: "emitters",
		emittery: "emitters",
	}[implementation]
	if (!path) throw new Error(`Unknown implementation: ${implementation}`)
	const adapter = await import(`./dist/${path}.js`)
	return adapter.make ?? adapter[implementation]
}
const gc = async () => {
	if (!globalThis.gc) throw new Error("Memory benchmarks require --expose-gc")
	await immediate()
	for (let i = 0; i < methodology.gcPasses; i++) {
		globalThis.gc()
		await immediate()
	}
	return process.memoryUsage().heapUsed
}
const runMemory = async (spec, make, options) => {
	if (spec.scenario === "memory-steady") {
		let prime = await Effect.runPromise(make(spec))
		await withCleanup(
			() => Effect.runPromise(prime.run),
			async () => {
				await Effect.runPromise(prime.close)
				prime = undefined
			},
		)
		await gc()
	}
	const values = []
	const traces = []
	for (let sample = 0; sample < options.memorySamples; sample++) {
		let fixture = await Effect.runPromise(make(spec))
		await withCleanup(
			async () => {
				const cycles = spec.scenario === "memory-cycles" ? options.cycles : 1
				const intervals = Math.min(5, cycles)
				const checkpoints = Array.from(
					{ length: intervals + 1 },
					(_, index) => ({
						cycle: Math.round((index * cycles) / intervals),
						bytes: 0,
					}),
				)
				if (spec.scenario === "memory-cycles")
					for (let i = 0; i < 5; i++) await Effect.runPromise(fixture.run)
				const before = await gc()
				checkpoints[0].bytes = before
				let checkpoint = 1
				for (let cycle = 1; cycle <= cycles; cycle++) {
					await Effect.runPromise(fixture.run)
					if (
						spec.scenario === "memory-cycles" &&
						checkpoints[checkpoint]?.cycle === cycle
					) {
						checkpoints[checkpoint].bytes = await gc()
						checkpoint++
					}
				}
				const after = await gc()
				if (spec.scenario === "memory-steady") checkpoints[1].bytes = after
				const value =
					spec.scenario === "memory-cycles"
						? after - before
						: (after - before) / spec.size
				assert.deepEqual(
					fixture.read(),
					expected(
						spec,
						false,
						spec.scenario === "memory-cycles" ? cycles + 5 : 1,
					),
				)
				values.push(value)
				const xs = checkpoints.map((point) => point.cycle)
				const ys = checkpoints.map((point) => point.bytes)
				const mx = xs.reduce((a, b) => a + b, 0) / xs.length
				const my = ys.reduce((a, b) => a + b, 0) / ys.length
				const denominator = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0)
				traces.push({
					before,
					after,
					checkpoints,
					slopeBytesPerCycle:
						denominator === 0
							? null
							: xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) /
								denominator,
				})
			},
			async () => {
				await Effect.runPromise(fixture.close)
				fixture = undefined
			},
		)
	}
	return {
		kind: "memory",
		unit: spec.scenario === "memory-cycles" ? "bytes/batch" : "bytes/plugin",
		...statistics(values),
		opsPerSecond: null,
		traces,
		cycles: options.cycles,
	}
}
export const runWorker = async ({
	implementation,
	spec,
	quick,
	options: suppliedOptions,
}) => {
	const make = await factoryFor(implementation)
	const options =
		suppliedOptions ?? (quick ? methodology.quick : methodology.full)
	if (spec.scenario.startsWith("memory-")) return runMemory(spec, make, options)
	let fixture
	let lastAudit
	const started = performance.now()
	const samples = []
	const batches = []
	let measuredTime = 0
	let summary
	do {
		const bench = new Bench({
			...options,
			throws: true,
			retainSamples: true,
			warmup: batches.length === 0,
			signal: quick
				? undefined
				: AbortSignal.timeout(
						Math.max(
							1,
							Math.ceil(options.maxWallTime - (performance.now() - started)),
						),
					),
		})
		bench.add("operation", () => Effect.runPromise(fixture.run), {
			async: true,
			beforeEach: async () => {
				fixture = await Effect.runPromise(make(spec))
			},
			afterEach: async () => {
				await withCleanup(
					() => {
						assert.deepEqual(fixture.read(), expected(spec))
					},
					() => Effect.runPromise(fixture.close),
				)
				lastAudit = fixture.read()
				assert.deepEqual(lastAudit, expected(spec, true))
				fixture = undefined
			},
		})
		await withCleanup(
			() => bench.run(),
			() => (fixture ? Effect.runPromise(fixture.close) : undefined),
		)
		const result = bench.tasks[0].result
		if (
			result.state !== "completed" &&
			result.state !== "aborted-with-statistics"
		)
			throw new Error(`Benchmark did not complete: ${result.state}`)
		const latency = result.latency
		for (const value of latency.samples) samples.push(value)
		measuredTime += latency.samples.reduce((sum, value) => sum + value, 0)
		summary = statistics(samples)
		batches.push({
			samples: latency.samples.length,
			mean: latency.mean,
			rme: latency.rme,
			state: result.state,
		})
	} while (
		!quick &&
		summary.rme > options.precisionTargetRme &&
		measuredTime < options.maxMeasuredTime &&
		performance.now() - started < options.maxWallTime
	)
	const operations =
		spec.scenario === "service" || spec.scenario.startsWith("events-")
			? spec.calls
			: 1
	return {
		kind: "timing",
		unit: "ms/batch",
		...summary,
		opsPerSecond: (1000 * operations) / summary.mean,
		operationsPerBatch: operations,
		precision: {
			batches,
			measuredTimeMs: measuredTime,
			wallTimeMs: performance.now() - started,
			targetRme: quick ? null : options.precisionTargetRme,
			capped: !quick && summary.rme > options.precisionTargetRme,
		},
		audit: lastAudit,
	}
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	runWorker(JSON.parse(process.argv[2])).then(
		(result) => process.stdout.write(JSON.stringify(result)),
		(error) => {
			process.stderr.write(`${inspect(error, { depth: null })}\n`)
			process.exitCode = 1
		},
	)
}
