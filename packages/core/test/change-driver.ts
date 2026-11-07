import { Context, Deferred, Effect } from "effect"

import { Change, Graft, Plugin, Transition, Trust } from "../src/index.ts"

export const budget: Change.Budget = {
	total: 10000,
	startup: 100,
	probe: 100,
	drain: 100,
	stop: 100,
	terminate: 100,
}
export const candidate = (identity: string): Change.Candidate => ({
	driver: "controlled",
	identity,
	deployment: identity,
})
export class Value extends Context.Service<
	Value,
	{
		readonly read: Effect.Effect<
			string,
			| Transition.AdmissionRejected
			| Transition.DriverError
			| Transition.Unavailable
			| Trust.Unapproved
		>
	}
>()("@graftland/graft/test/change-driver/Value") {}
export const register = Effect.fnUntraced(function* (
	instance: string,
	options: {
		readonly budget?: Change.Request["budget"]
		readonly requirements?: Change.Request["requirements"]
		readonly prepare?: Transition.Driver["prepare"]
		readonly ready?: Effect.Effect<void>
		readonly inject?: boolean
		readonly facade?: boolean
		readonly holdOldExit?: boolean
		readonly cleanup?: Effect.Effect<void>
	} = {},
) {
	const entered = yield* Deferred.make<void>()
	const oldExit = yield* Deferred.make<Change.Termination>()
	const driver: Transition.Driver = {
		name: "controlled",
		overlap: () => true,
		prepare: options.prepare,
		allocate: (desired, term, acknowledgement) =>
			Effect.gen(function* () {
				if (term === 1 && options.cleanup !== undefined)
					yield* Effect.addFinalizer(() => options.cleanup ?? Effect.void)
				const exited =
					term === 1 ? oldExit : yield* Deferred.make<Change.Termination>()
				return {
					acknowledgement,
					start: Effect.void,
					describe: Effect.succeed({ overlap: true, provides: [] }),
					serve: Effect.void,
					ready: (term === 1
						? Effect.void
						: Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(options.ready ?? Effect.void),
							)
					).pipe(
						Effect.as(
							Context.make(Value, { read: Effect.succeed(desired.identity) }),
						),
					),
					probe: () => Effect.void,
					stop: Effect.void,
					terminate:
						options.holdOldExit === true && term === 1
							? Effect.void
							: Deferred.succeed(exited, {
									unit: `${instance}-${term}`,
									state: "Exited",
								}).pipe(Effect.asVoid),
					exited: Deferred.await(exited),
					failure: Effect.never,
				}
			}),
	}
	const fork = yield* Graft.plugin(
		Plugin.make({
			name: `controlled/${instance}`,
			inject: options.inject === true ? [Value] : [],
			apply: () =>
				Transition.registerDriver(driver, {
					instance,
					initial: candidate("old"),
					budget: options.budget ?? budget,
					requirements: options.requirements,
					required: [],
					facades:
						options.facade === true
							? [
									Transition.facade(Value, (invoke) => ({
										read: invoke((service) => service.read),
									})),
								]
							: [],
				}),
		}),
	)
	yield* fork.await
	return { fork, entered, oldExit }
})
