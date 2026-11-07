import { pathToFileURL } from "node:url"
import { inspect } from "node:util"

import { Cause, Effect, Exit, Stream } from "effect"

import { withCleanup } from "./cleanup.mjs"
import { makeRemote } from "./remote-fixture.mjs"
import {
	captureNativeStdout,
	completed,
	observeExecutions,
	raw,
} from "./remote-native.mjs"

const check = (value, message) => {
	if (!value) throw new Error(message)
}
export const equivalence = async (connection) => {
	const probe = observeExecutions()
	let fixture
	const facts = {
		connection,
		echoes: 0,
		batchEchoes: 0,
		streamValues: [],
		updates: 0,
		cpu: 0,
		logs: 0,
		activations: 0,
		finalizers: 0,
		crashVerified: false,
	}
	return withCleanup(
		async () => {
			if (connection.startsWith("raw-")) {
				fixture = await raw(connection, probe)
				const ready = await fixture.echo("ready")
				check(ready.sequence === 1, "Raw readiness echo differs")
				const results = await completed(
					[0, 1, 2, 3].map(() => fixture.echo("x".repeat(100))),
				)
				check(
					results.every((r) => r.text === "x".repeat(100) && r.value === 1),
					"Raw payload results differ",
				)
				check(
					results
						.map((r) => r.sequence)
						.sort((a, b) => a - b)
						.join(",") === "2,3,4,5",
					"Raw concurrent sequences differ",
				)
				facts.echoes = results.length
				const batch = await fixture.batch(["a", "b"])
				check(
					batch.map((r) => r.sequence).join(",") === "6,7" &&
						batch.map((r) => r.text).join(",") === "a,b",
					"Raw batch results differ",
				)
				facts.batchEchoes = batch.length

				await fixture.close()
				fixture = undefined
			} else {
				if (connection === "in-process") {
					const frame =
						await import("../plugin-remote/dist/internal/runner/Framing.js")
					const at = await Effect.runPromise(
						Effect.exit(
							frame.encode({
								channel: 1,
								payload: new Uint8Array(frame.maxPayload),
							}),
						),
					)
					const over = await Effect.runPromise(
						Effect.exit(
							frame.encode({
								channel: 1,
								payload: new Uint8Array(frame.maxPayload + 1),
							}),
						),
					)
					check(
						Exit.isSuccess(at) && at.value.byteLength === frame.maxPayload + 8,
						"The exact frame limit was not accepted",
					)
					check(
						Exit.isFailure(over) &&
							JSON.stringify(over.cause).includes("FrameError"),
						"An oversized frame was not rejected",
					)
					facts.frameBoundary = {
						limit: frame.maxPayload,
						header: 8,
						atAccepted: true,
						overRejected: true,
						rejectionCause: over.cause,
					}
				}
				fixture = await makeRemote(connection, probe, {
					testLease: "300 millis",
				})
				const e = await fixture.load()
				const results = await completed(
					[0, 1, 2, 3].map(() => fixture.run(e.api.echo("x".repeat(100)))),
				)
				check(
					results.every((r) => r.text === "x".repeat(100) && r.value === 1),
					"Remote payload results differ",
				)
				check(
					results
						.map((r) => r.sequence)
						.sort((a, b) => a - b)
						.join(",") === "2,3,4,5",
					"Remote concurrent sequences differ",
				)
				facts.echoes = results.length

				check(
					(await fixture.run(e.api.info)).calls === 5,
					"The service observed an incorrect call count",
				)
				const batch = await fixture.run(e.api.batch(["a", "b"]))
				check(
					batch.map((r) => r.sequence).join(",") === "6,7" &&
						batch.map((r) => r.text).join(",") === "a,b",
					"Remote batch results differ",
				)
				facts.batchEchoes = batch.length
				check(
					(await fixture.run(e.api.info)).calls === 7,
					"Batch service call count differs",
				)
				facts.streamValues = await fixture.run(
					Stream.runCollect(e.api.values(4)),
				)
				check(
					facts.streamValues.join(",") === "0,1,2,3",
					"Stream values differ",
				)
				facts.cpu = await fixture.run(e.api.burn(10))
				check(facts.cpu === -1549426461, "CPU work differs from the reference")
				await fixture.update(e, 2)
				facts.updates++
				await fixture.run(e.api.logs(4, true))
				await fixture.stop(e)
				facts.logs = fixture.observer.logs
				check(
					facts.logs === 4 && fixture.observer.dropped === 0,
					"Paced log forwarding differs",
				)
				const expected = connection === "in-process" ? 1 : 2
				check(
					fixture.observer.activations === expected &&
						fixture.observer.finalizers === expected,
					"Config lifecycle counts differ from declared connection semantics",
				)
				facts.activations = fixture.observer.activations
				facts.finalizers = fixture.observer.finalizers
				if (connection !== "in-process") {
					const crashed = await fixture.load()
					const call = fixture.run(Effect.exit(crashed.api.crash))
					const failure = await fixture.failed(crashed)
					const exit = await call
					check(
						failure.code === 73 && Exit.isFailure(exit),
						"Process/worker did not actually crash",
					)
					check(
						fixture.observer.activations === fixture.observer.finalizers,
						"Crash left a consumer active",
					)
					facts.crashVerified = true
					facts.crashCause = Cause.pretty(exit.cause)
					facts.crashCauseData = exit.cause
				}
				await fixture.close()
				fixture = undefined
			}
			facts.executions = await probe.verify()
			return facts
		},
		async () =>
			withCleanup(
				async () => {
					if (fixture) await fixture.close()
				},
				async () => {
					await probe.cleanup()
					probe.restore()
				},
			),
	)
}
if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	const stdout = captureNativeStdout()
	equivalence(process.argv[2]).then(
		(r) => {
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
