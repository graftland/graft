import { Plugin, type Graft } from "@graftland/graft"
import { Cause, Deferred, Effect, FiberSet, Option, Schema } from "effect"
import { Worker } from "node:worker_threads"
import { WorkerTransport } from "../Transport"
import { ProcessExited, TransportError } from "../Errors"
import * as Channel from "../internal/workerChannel"
import * as FailureGroup from "../internal/FailureGroup"
import { Bootstrap } from "../internal/workerBootstrap"
import { cleanupCause } from "../internal/cleanup"

const start: typeof WorkerTransport.Service.start = Effect.fnUntraced(
	function* (options) {
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
						new URL(import.meta.resolve("@graftland/remote/worker")),
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
		const threadId = worker.threadId
		const channel = yield* Channel.make(worker)
		return {
			channel,
			pid: Option.none(),
			threadId,
			failure: failures.await,
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
)
const plugin: Plugin.Plugin<void, void, Graft.ServiceConflict> = Plugin.service(
	WorkerTransport,
	Effect.succeed({ start }),
	{ name: "remote-worker-transport" },
)
export default plugin
