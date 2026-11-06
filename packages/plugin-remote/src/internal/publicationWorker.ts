import { Worker } from "node:worker_threads"

import { Cause, Deferred, Effect, FiberSet, Schema } from "effect"

import { PublicationError, type EntryInput } from "./publicationModel"
import { Request, Response } from "./publicationProtocol"

const failure = (message: string, cause?: Cause.Cause<unknown>) =>
	PublicationError.make({ message, ...(cause === undefined ? {} : { cause }) })

export const inspectFresh = Effect.fn("Publication.inspectFresh")(function* (
	directory: string,
	entry: EntryInput,
) {
	const data = yield* Schema.encodeEffect(Request)({ directory, entry })
	const reply = yield* Deferred.make<unknown, PublicationError>()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const onMessage = (value: unknown) => run(Deferred.succeed(reply, value))
	const onError = (error: Error) =>
		run(
			Deferred.fail(
				reply,
				failure("Publication inspector failed", Cause.die(error)),
			),
		)
	const onExit = (code: number) =>
		run(
			Deferred.fail(
				reply,
				failure(`Publication inspector exited without a result (code ${code})`),
			),
		)
	yield* Effect.acquireRelease(
		Effect.try({
			try: () => {
				const worker = new Worker(
					new URL(
						import.meta
							.resolve("@graftland/plugin-remote/internal/publication"),
					),
					{ workerData: data, execArgv: [] },
				)
				worker.on("message", onMessage)
				worker.on("error", onError)
				worker.on("exit", onExit)
				return worker
			},
			catch: (cause) =>
				failure("Cannot start publication inspector", Cause.die(cause)),
		}),
		(worker) =>
			Effect.tryPromise({
				try: () => worker.terminate(),
				catch: (cause) =>
					failure("Cannot terminate publication inspector", Cause.die(cause)),
			}).pipe(
				Effect.orDie,
				Effect.ensuring(
					Effect.sync(() => {
						worker.off("message", onMessage)
						worker.off("error", onError)
						worker.off("exit", onExit)
					}),
				),
			),
	)
	const result = yield* Deferred.await(reply).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Response)),
	)
	return yield* result.pipe(
		Effect.catchCause((cause) =>
			failure(
				`Cannot inspect ${entry.implementation}: ${Cause.pretty(cause)}`,
				cause,
			),
		),
	)
}, Effect.scoped)
