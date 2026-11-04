import { assert, it } from "@effect/vitest"
import { Fork, Graft, Plugin } from "@graftland/graft"
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	PlatformError,
	Ref,
	Schema,
	Sink,
	Stdio,
	Stream,
} from "effect"
import { Listener, type Channel } from "../src/Transport"
import { Peer } from "../src/internal/Peer"
import { accept } from "../src/internal/runner/accept"
import { ReleaseInterrupted } from "@graftland/graft/Release"
import stdio from "../src/runner/stdio"

const unexpected = Effect.die("Unexpected session request")
const supervisor = {
	await: Effect.never,
	status: () => unexpected,
	highWater: () => unexpected,
	open: () => unexpected,
	renew: () => unexpected,
	load: () => unexpected,
	dispose: () => unexpected,
}
const execution = { peer: () => unexpected }

for (const location of ["output", "session"]) {
	for (const outcome of ["success", "interrupt", "die"]) {
		it.effect(
			`retains stdio ${location} release ${outcome} through a serving task`,
			() =>
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>()
					const cleaned = yield* Ref.make(false)
					const completed = yield* Ref.make(false)
					const cleanup = Ref.set(cleaned, true).pipe(
						Effect.andThen(
							outcome === "interrupt"
								? Effect.interrupt
								: outcome === "die"
									? Effect.die("release failed")
									: Effect.void,
						),
						Effect.andThen(Ref.set(completed, true)),
					)
					yield* Graft.provide(
						Stdio.Stdio,
						Stdio.make({
							args: Effect.succeed([]),
							stdin: Stream.never,
							stderr: () => Sink.drain,
							stdout: () =>
								location === "output"
									? Sink.unwrap(
											Effect.acquireRelease(
												Deferred.succeed(entered, undefined),
												() => cleanup,
											).pipe(Effect.as(Sink.drain)),
										)
									: Sink.drain,
						}),
					)
					const provider = yield* Graft.plugin(stdio, {})
					yield* provider.await
					const caller = yield* Graft.plugin(
						Plugin.make({
							name: "stdio session",
							inject: [Listener],
							apply: () =>
								Effect.gen(function* () {
									const listener = yield* Listener
									const serving = yield* listener.bind(Option.none())
									yield* Plugin.fork(
										serving.serve(() =>
											Effect.succeed((channel: Channel) =>
												Effect.gen(function* () {
													if (location === "session") {
														yield* Effect.addFinalizer(() => cleanup)
														yield* Deferred.succeed(entered, undefined)
													}
													return yield* accept(
														supervisor,
														execution,
														channel,
													).pipe(Effect.provideService(Peer, "test"))
												}),
											),
										),
									)
								}),
						}),
					)
					yield* Deferred.await(entered)
					const closed = yield* Effect.exit(caller.dispose)
					const finalized = yield* Ref.get(cleaned)
					const finished = yield* Ref.get(completed)
					assert.isTrue(finalized)
					assert.strictEqual(finished, outcome === "success")
					if (outcome === "success") assert.deepStrictEqual(closed, Exit.void)
					else {
						assert(Exit.isFailure(closed))
						const error = Cause.squash(closed.cause)
						assert(Schema.is(Fork.CleanupError)(error))
						if (outcome === "interrupt") {
							const release = Cause.squash(error.cause)
							assert(Schema.is(ReleaseInterrupted)(release))
							assert.isTrue(Cause.hasInterruptsOnly(release.cause))
						} else assert.include(Cause.pretty(error.cause), "release failed")
					}
				}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
		)
	}
}

it.effect(
	"ends stdio after an output failure even when the session handles the disconnect",
	() =>
		Effect.gen(function* () {
			const cleaned = yield* Ref.make(false)
			const failure = PlatformError.systemError({
				module: "Stdio",
				method: "stdout",
				_tag: "Unknown",
				cause: "write EPIPE",
			})
			yield* Graft.provide(
				Stdio.Stdio,
				Stdio.make({
					args: Effect.succeed([]),
					stdin: Stream.never,
					stderr: () => Sink.drain,
					stdout: () => Sink.fail(failure),
				}),
			)
			const provider = yield* Graft.plugin(stdio, {})
			yield* provider.await
			const caller = yield* Graft.plugin(
				Plugin.make({
					name: "broken stdio session",
					inject: [Listener],
					apply: Effect.fnUntraced(function* () {
						const listener = yield* Listener
						const serving = yield* listener.bind(Option.none())
						yield* Plugin.fork(
							serving.serve(() =>
								Effect.succeed((channel: Channel) =>
									Effect.addFinalizer(() => Ref.set(cleaned, true)).pipe(
										Effect.andThen(
											Stream.run(
												Stream.make(new Uint8Array([1])),
												channel.output,
											),
										),
										Effect.catchCause((cause) =>
											Effect.logWarning("Session disconnected", cause),
										),
									),
								),
							),
						)
					}),
				}),
			)
			const state = yield* caller.state.pipe(
				Stream.filter((state) => state._tag === "Failed"),
				Stream.runHead,
				Effect.flatMap(Effect.fromOption),
			)
			assert.equal(state._tag, "Failed")
			if (state._tag === "Failed")
				assert.include(Cause.pretty(state.cause), "write EPIPE")
			const finalized = yield* Ref.get(cleaned)
			assert.isTrue(finalized)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
