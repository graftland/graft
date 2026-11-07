import { monitorEventLoopDelay } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { inspect } from "node:util"

import { Cause, Effect, Exit, Stream } from "effect"

import { withCleanup } from "./cleanup.mjs"
import { remoteMethodology } from "./remote-catalog.mjs"
import { makeRemote } from "./remote-fixture.mjs"
import {
	captureNativeStdout,
	completed,
	observeExecutions,
	raw,
} from "./remote-native.mjs"
import { statistics } from "./statistics.mjs"

const assert = (condition, message) => {
	if (!condition) throw new Error(message)
}
const timed = async (operation) => {
	const started = performance.now()
	const value = await operation()
	return { ms: performance.now() - started, value }
}
const collect = async (count, warmup, operation) => {
	const samples = []
	const observations = []
	for (let i = -warmup; i < count; i++) {
		const sample = await operation(i)
		if (i >= 0) {
			samples.push(sample.ms)
			observations.push(sample.observation ?? sample.value)
		}
	}
	return { samples, observations }
}
const gc = () => {
	assert(
		typeof global.gc === "function",
		"Remote memory benchmarks require --expose-gc",
	)
	for (let i = 0; i < remoteMethodology.gcPasses; i++) global.gc()
}
export const runRemote = async ({ implementation, spec, quick }) => {
	const options = remoteMethodology[quick ? "quick" : "full"]
	const probe = observeExecutions()
	let measurement
	const boundaryCleanup = []
	const protocolDiagnostics = []
	const execute = async () => {
		const scenario = spec.scenario
		const expectedRejection =
			scenario === "remote-r4-payload" &&
			spec.size >= remoteMethodology.framePayloadLimitBytes &&
			["remote-unix", "remote-ws"].includes(implementation)
		const isRaw = implementation.startsWith("raw-")
		let fx
		let rawFixture
		let entry
		let calls = 1
		const hooks = {}
		const open = async () => {
			if (isRaw) {
				rawFixture = await raw(implementation, probe)
				await rawFixture.echo("ready")
			} else fx = await makeRemote(implementation, probe, hooks)
		}
		const close = async () => {
			if (fx) {
				const current = fx
				fx = undefined
				protocolDiagnostics.push(...current.observer.diagnostics)
				if (expectedRejection) {
					const exit = await current.closeObserved()
					if (Exit.isFailure(exit)) {
						assert(
							JSON.stringify(exit.cause).includes("FrameError"),
							"Unexpected cleanup failure after payload rejection",
						)
						boundaryCleanup.push({
							cause: Cause.pretty(exit.cause),
							causeData: exit.cause,
						})
					}
				} else await current.close()
			}
			if (rawFixture) {
				const current = rawFixture
				rawFixture = undefined
				await current.close()
			}
		}
		const echo = (text) =>
			isRaw ? rawFixture.echo(text) : fx.run(entry.api.echo(text))
		const validateEcho = (value, text) => {
			calls++
			assert(
				value.text === text && value.sequence === calls && value.value === 1,
				"Echo work differs from the reference",
			)
		}

		const auditCalls = async () => {
			if (!isRaw)
				assert(
					(await fx.run(entry.api.info)).calls === calls,
					"Published service call count differs from completed calls",
				)
		}
		return withCleanup(async () => {
			await open()
			if (
				[
					"remote-r2-call",
					"remote-r3-throughput",
					"remote-r3-batch",
					"remote-r4-payload",
					"remote-r5-stream",
					"remote-r8-loop",
				].includes(scenario)
			) {
				if (!isRaw) entry = await fx.load()
			}
			if (
				scenario === "remote-r1-start" ||
				scenario === "remote-r1-stop" ||
				scenario === "remote-r6-config"
			) {
				return collect(options.lifecycleSamples, options.warmup, async (i) => {
					let sample
					if (scenario === "remote-r1-start") {
						sample = await timed(() => fx.load())
						await fx.stop(sample.value)
					} else {
						const e = await fx.load()
						sample = await timed(() =>
							scenario === "remote-r1-stop" ? fx.stop(e) : fx.update(e, 2),
						)
						if (scenario === "remote-r6-config") {
							assert(sample.value.value === 2, "Config result differs")
							await fx.stop(e)
						}
					}
					assert(
						fx.observer.activations === fx.observer.finalizers,
						"Lifecycle finalizers did not match activations",
					)
					return {
						ms: sample.ms,
						observation: {
							activations: fx.observer.activations,
							finalizers: fx.observer.finalizers,
						},
					}
				})
			}
			if (scenario === "remote-r2-call") {
				const result = await collect(
					options.callSamples,
					options.callWarmup,
					async () => {
						const sample = await timed(() => echo("x"))
						validateEcho(sample.value, "x")
						return { ms: sample.ms }
					},
				)
				await auditCalls()
				return { ...result, completedCalls: calls, operationsPerSample: 1 }
			}
			if (scenario === "remote-r3-batch") {
				const texts = Array.from({ length: spec.calls }, () => "x")
				const result = await collect(
					options.batchSamples,
					options.warmup,
					async () => {
						const sample = await timed(() =>
							isRaw ? rawFixture.batch(texts) : fx.run(entry.api.batch(texts)),
						)
						const values = sample.value
						assert(
							values.length === spec.calls &&
								values.every(
									(r, i) =>
										r.text === "x" &&
										r.value === 1 &&
										r.sequence === calls + i + 1,
								),
							"Batch work differs from unary calls",
						)
						calls += spec.calls
						return { ms: sample.ms }
					},
				)
				await auditCalls()
				return {
					...result,
					completedCalls: calls,
					operationsPerSample: spec.calls,
				}
			}
			if (scenario === "remote-r3-throughput") {
				const result = await collect(
					options.batchSamples,
					options.warmup,
					async () => {
						// Concurrency intentionally reorders completions; validate sequence uniqueness and all replies per batch.
						const started = performance.now()
						let issued = 0
						const values = []
						const one = async () => {
							while (issued < spec.calls) {
								issued++
								const r = isRaw
									? await rawFixture.echo("x")
									: await fx.run(entry.api.echo("x"))
								values.push(r)
							}
						}
						await completed(Array.from({ length: spec.size }, one))
						const elapsed = performance.now() - started
						const sequences = values
							.map((v) => v.sequence)
							.sort((a, b) => a - b)
						assert(
							values.length === spec.calls &&
								values.every((v) => v.text === "x" && v.value === 1),
							"Concurrent call results differ",
						)
						assert(
							sequences.every((s, i) => s === calls + i + 1),
							"Concurrent calls were lost or duplicated",
						)
						calls += spec.calls
						return { ms: elapsed }
					},
				)
				await auditCalls()
				return {
					...result,
					completedCalls: calls,
					operationsPerSample: spec.calls,
				}
			}
			if (scenario === "remote-r4-payload") {
				const text = "x".repeat(spec.size)
				if (
					spec.size < remoteMethodology.framePayloadLimitBytes ||
					!implementation.startsWith("remote-") ||
					["remote-local", "remote-worker"].includes(implementation)
				) {
					const result = await collect(
						options.batchSamples,
						options.warmup,
						async () => {
							const s = await timed(() => echo(text))
							validateEcho(s.value, text)
							return { ms: s.ms }
						},
					)
					await auditCalls()
					return {
						...result,
						outcome: "accepted",
						completedCalls: calls,
						payloadBytes: spec.size,
					}
				}
				// An over-limit runner request destroys its session: recreate the entry between independent probes.
				const result = await collect(options.boundarySamples, 0, async (i) => {
					if (i > 0) {
						await close()
						await open()
						entry = await fx.load()
					}
					const started = performance.now()
					const exit = await fx.run(
						Effect.exit(
							entry.api.echo(text).pipe(Effect.timeout("30 seconds")),
						),
					)
					assert(
						Exit.isFailure(exit),
						"The runner unexpectedly accepted an over-limit protocol payload",
					)
					return {
						ms: performance.now() - started,
						observation: {
							outcome: "rejected",
							cause: Cause.pretty(exit.cause),
							causeData: exit.cause,
						},
					}
				})
				return {
					...result,
					outcome: "rejected",
					opsPerSecond: null,
					payloadBytes: spec.size,
					substitute:
						"Time until oversized request rejection; no successful call throughput.",
				}
			}
			if (scenario === "remote-r5-stream") {
				const result = await collect(
					options.batchSamples,
					options.warmup,
					async () => {
						const sample = await timed(() =>
							fx.run(Stream.runCollect(entry.api.values(spec.size))),
						)
						assert(
							sample.value.length === spec.size &&
								sample.value.every((n, i) => n === i),
							"Stream values differ",
						)
						return { ms: sample.ms }
					},
				)
				return { ...result, valuesPerStream: spec.size }
			}
			if (
				scenario === "remote-r7-footprint" ||
				scenario === "remote-r7-start"
			) {
				// Each sample gets a fresh root; GC and platform/runner setup are outside timing.
				await close()
				const result = await collect(options.footprintSamples, 0, async () => {
					await open()
					gc()
					const before = process.memoryUsage()
					const entries = []
					const sample = await timed(async () => {
						for (let i = 0; i < spec.size; i++) entries.push(await fx.load())
					})
					gc()
					const after = process.memoryUsage()
					const info = await completed(entries.map((e) => fx.run(e.api.info)))
					assert(
						info.length === spec.size && info.every((x) => x.calls === 1),
						"Footprint entries did different work",
					)
					const uniquePids = new Set(info.map((i) => i.pid))
					const observation = {
						hostHeapPerEntry: (after.heapUsed - before.heapUsed) / spec.size,
						hostRssDeltaPerEntry: (after.rss - before.rss) / spec.size,
						isolateHeapPerEntry:
							info.reduce((s, i) => s + i.heap, 0) / spec.size,
						processRssPerEntry:
							implementation === "remote-worker" ||
							implementation === "in-process"
								? null
								: info.reduce((s, i) => s + i.rss, 0) / spec.size,
						individualWorkerRss:
							"N/A: RSS is process-wide, not per worker isolate",
						uniquePluginPids: uniquePids.size,
						startMs: sample.ms,
						entries: spec.size,
					}
					for (const e of entries) await fx.stop(e)
					assert(
						fx.observer.activations === spec.size &&
							fx.observer.finalizers === spec.size,
						"Footprint consumers did not finalize",
					)
					await close()
					return {
						ms:
							scenario === "remote-r7-footprint"
								? observation.hostHeapPerEntry
								: sample.ms,
						observation,
					}
				})
				return {
					...result,
					startup: statistics(result.observations.map((o) => o.startMs)),
					kind: scenario === "remote-r7-footprint" ? "memory" : "timing",
					unit:
						scenario === "remote-r7-footprint" ? "bytes/entry" : "ms/start-N",
				}
			}
			if (scenario === "remote-r8-loop") {
				// V8 sees the same loop before samples in every connection.
				await fx.run(entry.api.burn(remoteMethodology.cpuIterations))
				const result = await collect(options.specialSamples, 0, async () => {
					const histogram = monitorEventLoopDelay({
						resolution: remoteMethodology.monitorResolutionMs,
					})
					histogram.enable()
					await delay(remoteMethodology.histogramPrimeMs)
					histogram.reset()
					await delay(remoteMethodology.monitorResolutionMs * 2)
					let unrelated
					hooks.notice = (kind, timestamp) => {
						if (kind === "cpu")
							unrelated = delay(remoteMethodology.unrelatedDelayMs).then(
								async () => {
									assert(
										(await fx.unrelated()) === 42,
										"Unrelated in-process service returned a different value",
									)
									return performance.now() - timestamp
								},
							)
					}
					const sample = await timed(() =>
						fx.run(entry.api.burn(remoteMethodology.cpuIterations)),
					)
					assert(unrelated !== undefined, "CPU notice was not delivered")
					const unrelatedMs = await unrelated
					await delay(remoteMethodology.histogramPrimeMs)
					histogram.disable()
					const observation = {
						burnMs: sample.ms,
						checksum: sample.value,
						eventLoopP50Ms: histogram.percentile(50) / 1e6,
						eventLoopP99Ms: histogram.percentile(99) / 1e6,
						eventLoopMaxMs: histogram.max / 1e6,
						unrelatedMs,
					}
					hooks.notice = undefined
					return { ms: sample.ms, observation }
				})
				return { ...result, cpuIterations: remoteMethodology.cpuIterations }
			}
			if (scenario === "remote-r9-logs") {
				const result = await collect(options.specialSamples, 0, async () => {
					const e = await fx.load()
					const before = { ...fx.observer }
					const cpu = process.cpuUsage()
					const threadCpu = process.threadCpuUsage()
					const started = performance.now()
					const production = await timed(() =>
						fx.run(e.api.logs(spec.size, spec.size === 100)),
					)
					assert(
						production.value === spec.size,
						"Logger attempted a different number of records",
					)
					await fx.stop(e)
					const ms = performance.now() - started
					const cost = process.cpuUsage(cpu)
					const threadCost = process.threadCpuUsage(threadCpu)
					const observation = {
						attempted: spec.size,
						received: fx.observer.logs - before.logs,
						dropped: fx.observer.dropped - before.dropped,
						warnings: fx.observer.warnings - before.warnings,
						productionMs: production.ms,
						productionPerSecond: spec.size / (production.ms / 1000),
						hostCpuMs: (cost.user + cost.system) / 1000,
						hostThreadCpuMs: (threadCost.user + threadCost.system) / 1000,
						warningsPerSecond:
							(fx.observer.warnings - before.warnings) / (ms / 1000),
						drainAndStopMs: ms - production.ms,
					}
					assert(
						observation.received + observation.dropped === spec.size,
						"Forwarded and dropped logs do not account for attempted logs",
					)
					return { ms, observation }
				})
				return {
					...result,
					substitute:
						"Logging plus graceful drain and stop; compare the zero-log control. Host thread CPU excludes worker execution; process CPU includes it.",
				}
			}
			if (scenario === "remote-r10-failure") {
				const result = await collect(options.specialSamples, 0, async () => {
					const e = await fx.load()
					let noticed
					hooks.notice = (kind, time) => {
						if (kind === "crash") noticed = time
					}
					const crash = fx.run(Effect.exit(e.api.crash))
					const detected = await fx.failed(e)
					const crashExit = await crash
					assert(
						Exit.isFailure(crashExit),
						"A crashed call unexpectedly succeeded",
					)
					assert(
						noticed !== undefined && detected.code === 73,
						"The intended execution did not actually crash",
					)
					assert(
						fx.observer.activations === fx.observer.finalizers,
						"Consumer was not stopped after process crash",
					)
					return {
						ms: detected.failedAt - noticed,
						observation: {
							...detected,
							noticeAt: noticed,
							nativeExitToFailedMs: detected.failedAt - detected.exitedAt,
							noticeToConsumerStopMs: detected.stoppedAt - noticed,
							crashCallCause: Cause.pretty(crashExit.cause),
							crashCallCauseData: crashExit.cause,
						},
					}
				})
				return { ...result, causes: fx.observer.causes }
			}
			throw new Error(`Unknown Remote scenario: ${scenario}`)
		}, close)
	}
	return withCleanup(
		async () => {
			const result = await execute()
			const summary = statistics(result.samples)
			measurement = {
				kind: "timing",
				unit: "ms/operation",
				...summary,
				opsPerSecond: (1000 * (result.operationsPerSample ?? 1)) / summary.mean,
				...result,
				boundaryCleanup,
				protocolDiagnostics,
				options,
			}
			if (result.outcome === "rejected" || measurement.kind === "memory")
				measurement.opsPerSecond = null
			measurement.executions = await probe.verify()
			return measurement
		},
		async () => {
			await probe.cleanup()
			probe.restore()
		},
	)
}
if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	const stdout = captureNativeStdout()
	runRemote(JSON.parse(process.argv[2])).then(
		(r) => {
			r.nativeStdout = stdout.read()
			stdout.restore()
			process.stdout.write(JSON.stringify(r) + "\n")
		},
		(error) => {
			stdout.restore()
			process.stderr.write(inspect(error, { depth: 20 }) + "\n")
			process.exitCode = 1
		},
	)
}
