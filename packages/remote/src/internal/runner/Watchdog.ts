import { Cause, Deferred, Effect, Schema } from "effect"
import * as FailureGroup from "../FailureGroup"
import { Worker } from "node:worker_threads"
import { ExecutionError } from "./model"
import { Notice } from "./WatchdogProtocol"

export const start = Effect.gen(function* () {
	const ready = yield* Deferred.make<void>()
	const begin = yield* Deferred.make<void>()
	const stop = yield* Deferred.make<void>()
	const worker = yield* Effect.acquireRelease(
		Effect.try({
			try: () =>
				new Worker(
					new URL(import.meta.resolve("@graftland/plugin-remote/watchdog")),
				),
			catch: (cause) =>
				ExecutionError.make({
					detail: "Starting the child watchdog failed",
					cause: Cause.die(cause),
				}),
		}),
		(worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
	)
	const listeners = yield* FailureGroup.make<ExecutionError>()
	const run = yield* listeners.runtime<never>()
	const message = (value: unknown) =>
		run(
			Schema.decodeUnknownEffect(Notice)(value).pipe(
				Effect.mapError((error) =>
					ExecutionError.make({
						detail: "Invalid watchdog notice",
						cause: Cause.fail(error),
					}),
				),
				Effect.flatMap((notice) =>
					Deferred.succeed(
						notice === "ready" ? ready : notice === "start" ? begin : stop,
						undefined,
					),
				),
				Effect.asVoid,
			),
		)
	const error = (error: Error) =>
		run(
			Effect.fail(
				ExecutionError.make({
					detail: "Child watchdog failed",
					cause: Cause.die(error),
				}),
			),
		)
	const exit = (code: number) =>
		run(
			Effect.fail(
				ExecutionError.make({
					detail: "Child watchdog exited: " + code,
				}),
			),
		)
	yield* Effect.acquireRelease(
		Effect.sync(() => {
			worker.on("message", message)
			worker.on("error", error)
			worker.on("exit", exit)
		}),
		() =>
			Effect.sync(() => {
				worker.off("message", message)
				worker.off("error", error)
				worker.off("exit", exit)
			}),
	)
	const failure = listeners.await
	yield* Effect.raceFirst(Deferred.await(ready), failure)
	return {
		begin: Effect.raceFirst(Deferred.await(begin), failure),
		stop: Effect.raceFirst(Deferred.await(stop), failure),
	}
})
