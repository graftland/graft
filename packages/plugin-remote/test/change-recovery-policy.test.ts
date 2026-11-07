import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Scope,
	String,
	TxRef,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition } from "@graftland/graft"

import * as Policy from "../src/Policy"

const budget: Change.Budget = {
	total: 10000,
	startup: 100,
	probe: 100,
	drain: 100,
	stop: 100,
	terminate: 100,
}
const candidate = (identity: string): Change.Candidate => ({
	driver: "controlled",
	identity,
	deployment: identity,
})
const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Graft.layer))

for (const revoke of [false, true])
	it.effect(
		revoke
			? "rechecks real policy approval before executing a freshly bound recovery"
			: "recovers an approved artifact after Restart releases its previous policy binding",
		() =>
			run(
				Effect.gen(function* () {
					const oldIdentity = {
						package: "@example/plugin",
						digest: String.repeat(64)("a"),
					}
					const nextIdentity = {
						package: "@example/plugin",
						digest: String.repeat(64)("b"),
					}
					const authority = yield* Policy.install({
						version: "1",
						entries: [
							{
								entry: "governed",
								artifact: oldIdentity,
								tier: "trusted",
								grants: [
									{
										_tag: "Http",
										id: "api",
										origin: "https://api.example",
										credential: "API_TOKEN",
									},
								],
							},
							{
								entry: "governed",
								artifact: nextIdentity,
								tier: "trusted",
								grants: [
									{
										_tag: "Http",
										id: "api",
										origin: "https://api.example",
										credential: "API_TOKEN",
									},
								],
							},
						],
					})
					for (const [name, identity] of [
						["old", oldIdentity],
						["next", nextIdentity],
					] as const) {
						yield* Effect.scoped(
							Effect.gen(function* () {
								yield* authority.bind("governed", name, identity, [])
								const expected = yield* authority.statement(
									"governed",
									identity,
								)
								const approval = yield* authority.review({
									expected,
									who: "reviewer",
								})
								yield* authority.approve(approval)
							}),
						)
					}
					const bind = (desired: Change.Candidate) =>
						authority
							.bind(
								"governed",
								desired.identity,
								desired.identity === "old" ? oldIdentity : nextIdentity,
								[],
							)
							.pipe(
								Effect.mapError((error) =>
									Transition.DriverError.make({ cause: Cause.fail(error) }),
								),
							)
					const recoveryStarted = yield* TxRef.make(false)
					const driver: Transition.Driver = {
						name: "controlled",
						prepare: (desired) =>
							bind(desired).pipe(Effect.as({ overlap: false })),
						allocate: (desired, term, acknowledgement) =>
							Effect.gen(function* () {
								yield* bind(desired)
								if (term === 3 && revoke)
									yield* authority
										.revoke(["api"])
										.pipe(
											Effect.mapError((error) =>
												Transition.DriverError.make({
													cause: Cause.fail(error),
												}),
											),
										)
								const exited = yield* Deferred.make<Change.Termination>()
								return {
									acknowledgement,
									start:
										desired.identity === "next"
											? Transition.DriverError.make({
													cause: Cause.fail("Candidate failed to start"),
												})
											: term === 3
												? TxRef.set(recoveryStarted, true)
												: Effect.void,
									describe: Effect.succeed({ overlap: false, provides: [] }),
									serve: Effect.void,
									ready: Effect.succeed(Context.empty()),
									probe: () => Effect.void,
									stop: Effect.void,
									terminate: Deferred.succeed(exited, {
										unit: `governed-${term}`,
										state: "Exited",
									}).pipe(Effect.asVoid),
									exited: Deferred.await(exited),
									failure: Effect.never,
								}
							}),
					}
					const fork = yield* Graft.plugin(
						Plugin.make({
							name: "governed",
							apply: () =>
								Transition.registerDriver(driver, {
									instance: "governed",
									initial: candidate("old"),
									budget,
									required: [],
									facades: [],
								}),
						}),
					)
					yield* fork.await
					const outcome = yield* Change.run({
						instance: "governed",
						candidate: candidate("next"),
						strategy: "Restart",
						budget,
					})
					assert.equal(
						outcome._tag,
						revoke ? "RecoveryFailed" : "Recovered",
						Array.join(
							Array.map(outcome.evidence, (item) =>
								item.cause === undefined ? "" : Cause.pretty(item.cause),
							),
							"\n",
						),
					)
					const started = yield* TxRef.get(recoveryStarted)
					assert.equal(started, !revoke)
					if (!revoke) yield* Policy.check("governed", "old")
				}),
			),
	)
