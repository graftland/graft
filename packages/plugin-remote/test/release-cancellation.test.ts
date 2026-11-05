import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Sink,
	Stream,
	Schema,
} from "effect"
import * as Release from "@graftland/graft/Release"
import { Connector } from "../src/Transport"
import { Credentials } from "../src/Auth"
import * as Connection from "../src/internal/runner/Connection"
import {
	LocalTransport,
	WorkerTransport,
} from "../src/internal/directTransport"

for (const mode of ["masked", "interruptible", "self", "joined", "mixed"]) {
	for (const timing of ["body", "release"]) {
		it.effect(
			`distinguishes ${mode} release interruption when cancellation reaches ${timing}`,
			() =>
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>()
					const closing = yield* Deferred.make<void>()
					const finish = yield* Deferred.make<void>()
					const completed = yield* Ref.make(false)
					const canceller = yield* Effect.withFiber((self) =>
						Effect.succeed(self.id),
					)
					const unrelated = yield* Effect.forkScoped(Effect.interrupt)
					yield* Fiber.await(unrelated)
					const work = Effect.gen(function* () {
						if (mode === "mixed")
							yield* Effect.addFinalizer(() =>
								Effect.interruptible(Effect.void),
							)
						yield* Effect.addFinalizer(() =>
							Deferred.succeed(closing, undefined).pipe(
								Effect.andThen(Deferred.await(finish)),
								Effect.andThen(
									mode === "interruptible"
										? Effect.interruptible(Effect.void)
										: mode === "self" || mode === "mixed"
											? Effect.interrupt
											: mode === "joined"
												? Fiber.join(unrelated)
												: Effect.void,
								),
								Effect.andThen(Ref.set(completed, true)),
							),
						)
						yield* Deferred.succeed(entered, undefined)
						if (timing === "body") return yield* Effect.never
					})
					const worker = yield* Release.scoped(work).pipe(Effect.forkScoped)
					yield* timing === "body"
						? Deferred.await(entered)
						: Deferred.await(closing)
					const stopping = yield* Fiber.interruptAs(worker, canceller).pipe(
						Effect.forkScoped({ startImmediately: true }),
					)
					yield* Deferred.await(closing)
					yield* Deferred.succeed(finish, undefined)
					yield* Fiber.join(stopping)
					const exit = yield* Fiber.await(worker)
					assert(Exit.isFailure(exit))
					assert.isTrue(
						Array.some(
							exit.cause.reasons,
							(reason) =>
								reason._tag === "Interrupt" && reason.fiberId === canceller,
						),
					)
					if (mode === "masked" || mode === "interruptible") {
						assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
					} else {
						const release = Cause.squash(exit.cause)
						assert(Schema.is(Release.ReleaseInterrupted)(release))
						assert.isTrue(Cause.hasInterruptsOnly(release.cause))
						assert.isTrue(
							Array.every(
								release.cause.reasons,
								(reason) =>
									reason._tag === "Interrupt" &&
									reason.fiberId ===
										(mode === "joined" ? unrelated.id : worker.id),
							),
						)
					}
					const released = yield* Ref.get(completed)
					assert.strictEqual(released, mode === "masked")
				}).pipe(Effect.scoped),
		)
	}
}

it.effect(
	"keeps acquisition cancellation ordinary through an interruptible connector release",
	() =>
		Effect.gen(function* () {
			const ready = yield* Deferred.make<void>()
			const canceller = yield* Effect.withFiber((self) =>
				Effect.succeed(self.id),
			)
			const fiber = yield* Connection.acquire(
				{ _tag: "Connector", instance: "test" },
				"unused",
				{ session: "test", call: {}, serve: {} },
				Effect.void,
				() => Effect.succeed(Cause.empty),
				"1 second",
			).pipe(
				Effect.scoped,
				Effect.provideService(LocalTransport, {
					start: () => Effect.die("Unexpected local connection"),
				}),
				Effect.provideService(WorkerTransport, {
					start: () => Effect.die("Unexpected worker connection"),
				}),
				Effect.provideService(Connector, {
					properties: {
						protocol: "test",
						encrypted: false,
						network: false,
						carries: [],
					},
					connect: Effect.fnUntraced(function* () {
						yield* Effect.addFinalizer(() => Effect.interruptible(Effect.never))
						yield* Deferred.succeed(ready, undefined)
						return { input: Stream.never, output: Sink.drain }
					}),
				}),
				Effect.provideService(Credentials, {
					kind: "None",
					read: Effect.succeed<{ readonly _tag: "None" }>({ _tag: "None" }),
				}),
				Effect.forkScoped,
			)
			yield* Deferred.await(ready)
			yield* Fiber.interrupt(fiber)
			const exit = yield* Fiber.await(fiber)
			assert(Exit.isFailure(exit))
			assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
			assert.isTrue(
				Array.every(
					exit.cause.reasons,
					(reason) =>
						reason._tag === "Interrupt" && reason.fiberId === canceller,
				),
			)
		}).pipe(Effect.scoped),
)
