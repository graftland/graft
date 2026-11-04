import { assert, it } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Ref,
	Schema,
	Scope,
} from "effect"
import { Event, Fork, Graft, Plugin } from "../src/index.ts"
import { ReleaseInterrupted } from "../src/internal/release.ts"
import { run } from "./utils.ts"

for (const shape of ["emit", "parallel", "next", "last", "task"]) {
	for (const phase of ["apply", "update", "parent"]) {
		it.effect(
			`retains ${shape} release interruption through ${phase} disposal`,
			() =>
				Effect.gen(function* () {
					const entered = yield* Deferred.make<number>()
					const completed = yield* Ref.make(false)
					const work = Effect.addFinalizer(() =>
						Effect.interrupt.pipe(Effect.andThen(Ref.set(completed, true))),
					).pipe(
						Effect.andThen(
							Effect.withFiber((self) => Deferred.succeed(entered, self.id)),
						),
						Effect.andThen(Effect.never),
					)
					const inner = Event.make<[]>("inner release")
					const outer = Event.make<[]>("outer release")
					const middleware = Event.middleware<void, void>("middleware release")
					yield* Event.on(inner, () => work)
					yield* Event.on(outer, () => Event.emit(inner))
					yield* Event.on(middleware, (input, next) => next(input))
					if (shape === "next") yield* Event.on(middleware, () => work)
					const dispatch =
						shape === "task"
							? Plugin.fork(Event.emit(inner)).pipe(Effect.asVoid)
							: shape === "next" || shape === "last"
								? Event.waterfall(middleware, undefined, () =>
										shape === "last" ? work : Effect.void,
									)
								: shape === "parallel"
									? Event.parallel(outer).pipe(Effect.asVoid)
									: Event.emit(outer)
					const parent = yield* Effect.acquireRelease(Scope.make(), Scope.close)
					const caller = yield* Graft.plugin(
						Plugin.make({
							name: "release propagation",
							apply: () =>
								phase === "update"
									? Effect.succeed(() => dispatch.pipe(Effect.as(true)))
									: dispatch,
						}),
					).pipe(Scope.provide(parent))
					if (phase === "update") {
						yield* caller.await
						yield* caller.update(undefined).pipe(Effect.forkScoped)
					}
					const handlerId = yield* Deferred.await(entered)
					const exit = yield* Effect.exit(
						phase === "parent"
							? Scope.close(parent, Exit.void)
							: caller.dispose,
					)
					assert(Exit.isFailure(exit))
					const cleanup = Cause.squash(exit.cause)
					assert(Schema.is(Fork.CleanupError)(cleanup))
					const interrupted = Cause.squash(cleanup.cause)
					assert(Schema.is(ReleaseInterrupted)(interrupted))
					assert.isTrue(Cause.hasInterruptsOnly(interrupted.cause))
					assert.isTrue(
						Array.some(
							interrupted.cause.reasons,
							(reason) =>
								reason._tag === "Interrupt" && reason.fiberId === handlerId,
						),
					)
					const released = yield* Ref.get(completed)
					assert.isFalse(released)
				}).pipe(run),
		)
	}
}
