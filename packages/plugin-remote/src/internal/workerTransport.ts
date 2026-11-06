import { Worker } from "node:worker_threads"

import {
	Cause,
	Deferred,
	Effect,
	FiberSet,
	Layer,
	Option,
	Schema,
} from "effect"

import { ProcessExited, TransportError } from "../Errors"
import { cleanupCause } from "./cleanup"
import { WorkerTransport } from "./directTransport"
import * as FailureGroup from "./FailureGroup"
import { Bootstrap } from "./workerBootstrap"
import * as Channel from "./workerChannel"

export const start: typeof WorkerTransport.Service.start = Effect.fnUntraced(
	function* (options, onSpawn) {
		const data = yield* Schema.encodeEffect(Bootstrap)(options).pipe(
			Effect.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		)
		const exited = yield* Deferred.make<number>()
		const failures = yield* FailureGroup.make<TransportError>()
		const callbacks = yield* FiberSet.make()
		const run = yield* FiberSet.runtime(callbacks)()
		const onExit = (code: number) => run(Deferred.succeed(exited, code))
		const onError = (error: Error) =>
			run(failures.fail(TransportError.make({ cause: Cause.die(error) })))
		const worker = yield* Effect.acquireRelease(
			Effect.try({
				try: () => {
					const worker = new Worker(
						new URL(
							import.meta.resolve("@graftland/plugin-remote/internal/worker"),
						),
						{
							workerData: data,
							...(options.execArgv === undefined
								? {}
								: { execArgv: [...options.execArgv] }),
						},
					)
					worker.on("exit", onExit)
					worker.on("error", onError)
					return worker
				},
				catch: (cause) => TransportError.make({ cause: Cause.die(cause) }),
			}),
			(worker) =>
				Effect.tryPromise({
					try: () => worker.terminate(),
					catch: (cause) => TransportError.make({ cause: Cause.die(cause) }),
				}).pipe(
					Effect.andThen(Deferred.await(exited)),
					Effect.ensuring(
						Effect.sync(() => {
							worker.off("exit", onExit)
							worker.off("error", onError)
						}),
					),
					Effect.catchCause((cause) => Effect.failCause(cleanupCause(cause))),
				),
		)
		yield* onSpawn ?? Effect.void
		const threadId = worker.threadId
		const channel = yield* Channel.make(worker)
		return {
			channel,
			pid: Option.none(),
			threadId,
			failure: failures.await,
			terminate: Effect.tryPromise({
				try: () => worker.terminate(),
				catch: (cause) => TransportError.make({ cause: Cause.die(cause) }),
			}).pipe(
				Effect.andThen(Deferred.await(exited)),
				Effect.flatMap((exitCode) =>
					failures.cause.pipe(
						Effect.map((statusCause) =>
							ProcessExited.make({
								pid: Option.none(),
								threadId,
								exitCode,
								stderr: "",
								statusCause,
							}),
						),
					),
				),
			),
			exited: Deferred.await(exited).pipe(
				Effect.flatMap((exitCode) =>
					failures.cause.pipe(
						Effect.map((statusCause) =>
							ProcessExited.make({
								pid: Option.none(),
								threadId,
								exitCode,
								stderr: "",
								statusCause,
							}),
						),
					),
				),
			),
		}
	},
	Effect.uninterruptible,
)
export const layer = Layer.succeed(WorkerTransport, { start })
