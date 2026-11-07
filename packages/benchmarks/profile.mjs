import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { Session } from "node:inspector"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inspect, parseArgs } from "node:util"

import { Effect } from "effect"

import { withCleanup } from "./cleanup.mjs"
import { expected } from "./dist/expectation.js"
import { factoryFor } from "./worker.mjs"

// Inspector runs only inside the executable boundary. Imports do not start a session.
export const profile = async (args = process.argv.slice(2)) => {
	const { values } = parseArgs({
		args,
		options: {
			implementation: { type: "string", default: "graft" },
			scenario: { type: "string", default: "events-emit" },
			size: { type: "string", default: "100" },
			calls: { type: "string", default: "100" },
			iterations: { type: "string", default: "10" },
			output: { type: "string", default: ".cache/profiles" },
		},
	})
	const directory = dirname(fileURLToPath(import.meta.url))
	const output = resolve(directory, values.output)
	const spec = {
		scenario: values.scenario,
		size: Number(values.size),
		calls: Number(values.calls),
	}
	if (!["events-emit", "cold-load"].includes(spec.scenario))
		throw new Error("Profiling supports events-emit and cold-load")
	const iterations = Number(values.iterations)
	for (const value of [spec.size, spec.calls, iterations])
		if (!Number.isSafeInteger(value) || value < 1)
			throw new Error("Profile dimensions must be positive integers")
	const make = await factoryFor(values.implementation)
	for (let i = 0; i < 5; i++) {
		const fixture = await Effect.runPromise(make(spec))
		await withCleanup(
			() => Effect.runPromise(fixture.run),
			() => Effect.runPromise(fixture.close),
		)
	}
	await mkdir(output, { recursive: true })
	const session = new Session()
	const post = (method, parameters = {}) =>
		new Promise((accept, reject) => {
			session.post(method, parameters, (error, result) =>
				error ? reject(error) : accept(result),
			)
		})
	session.connect()
	return withCleanup(
		async () => {
			await post("Profiler.enable")
			await post("Profiler.setSamplingInterval", { interval: 100 })
			const files = []
			for (let i = 0; i < iterations; i++) {
				const fixture = await Effect.runPromise(make(spec))
				await withCleanup(
					async () => {
						await post("Profiler.start")
						const begin = performance.now()
						await Effect.runPromise(fixture.run)
						const elapsedMs = performance.now() - begin
						const { profile: samples } = await post("Profiler.stop")
						assert.deepEqual(fixture.read(), expected(spec))
						const file = `${values.implementation}-${spec.scenario}-${i}.cpuprofile`
						await writeFile(resolve(output, file), JSON.stringify(samples))
						files.push({
							file,
							elapsedMs,
							samples: samples.samples?.length ?? 0,
						})
					},
					() => Effect.runPromise(fixture.close),
				)
			}
			const summary = {
				implementation: values.implementation,
				spec,
				iterations,
				samplingIntervalMicroseconds: 100,
				files,
				boundary:
					"Profiler commands surround fixture.run. Raw profiles also contain Inspector command samples; label those separately. Root construction, registration/setup, audit assertions and disposal are outside the operation window.",
			}
			await writeFile(
				resolve(output, `${values.implementation}-${spec.scenario}.json`),
				JSON.stringify(summary, null, 2),
			)
			return summary
		},
		() => session.disconnect(),
	)
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	profile().then(
		(result) => process.stdout.write(JSON.stringify(result) + "\n"),
		(error) => {
			process.stderr.write(inspect(error, { depth: null }))
			process.exitCode = 1
		},
	)
