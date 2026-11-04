import { Plugin } from "@graftland/graft"
import { Cause, Console, Effect, FileSystem, Schedule } from "effect"
import { config, Rejected } from "./contract"
import process from "node:process"
import { MessageChannel } from "node:worker_threads"

export default Plugin.make({
	name: "fixture-implementation",
	config,
	inject: [FileSystem.FileSystem],
	apply: ({ directory, mode, value }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const pid = process.pid
			process.stderr.write("Fixture stderr diagnostic\n")
			yield* fs.writeFileString(`${directory}/started-${pid}`, String(value))
			yield* Console.log("Console output must not corrupt the control channel")
			yield* Effect.logInfo("Remote fixture started").pipe(
				Effect.annotateLogs({ value, pid }),
			)
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					yield* fs
						.writeFileString(`${directory}/finalizing-${pid}`, "started")
						.pipe(Effect.orDie)
					yield* fs.exists(`${directory}/release`).pipe(
						Effect.orDie,
						Effect.repeat({
							schedule: Schedule.spaced("10 millis"),
							until: (exists) => exists,
						}),
					)
					yield* fs
						.writeFileString(`${directory}/finalized-${pid}`, "complete")
						.pipe(Effect.orDie)
					if (mode === "flood") {
						for (let index = 0; index < 4096; index++)
							yield* Effect.logInfo("Finalizer flood", index)
					}
					yield* Effect.logInfo("Remote fixture finalized")
					if (mode === "cleanup-fail")
						return yield* Effect.die(new Error("Remote finalizer failed"))
				}),
			)
			if (mode === "flood") {
				for (let index = 0; index < 4096; index++)
					yield* Effect.logInfo("Startup flood", index)
			}
			if (mode === "leaked-handle")
				yield* Effect.sync(() => {
					// Deliberately leak a referenced Node handle after all plugin finalizers finish.
					const channel = new MessageChannel()
					channel.port1.on("message", () => {})
				})
			if (mode === "wait")
				yield* fs.exists(`${directory}/activate`).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("10 millis"),
						until: (exists) => exists,
					}),
				)
			if (mode === "crash") {
				process.stderr.write("Crash diagnostic tail\n")
				process.exit(23)
			}
			if (mode === "retry") {
				const already = yield* fs.exists(`${directory}/attempted`)
				if (!already) {
					yield* fs.writeFileString(`${directory}/attempted`, String(pid))
					return yield* Rejected.make({ value })
				}
			}
			if (mode === "fail")
				return yield* Effect.failCause(
					Cause.combine(
						Cause.fail(Rejected.make({ value })),
						Cause.die(new Error("Remote apply defect")),
					),
				)
			if (mode === "background-fail" || (mode === "flood" && value === 2))
				yield* Plugin.fork(
					fs.exists(`${directory}/fail`).pipe(
						Effect.repeat({
							schedule: Schedule.spaced("10 millis"),
							until: (exists) => exists,
						}),
						Effect.andThen(Effect.fail(Rejected.make({ value }))),
					),
				)
		}),
})
