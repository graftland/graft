import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Ref,
	Schema,
	Scope,
	String,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Graft, Trust } from "@graftland/graft"

import * as Policy from "../src/Policy"

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Graft.layer))

const artifact = {
	package: "@example/untrusted",
	digest: String.repeat(64)("a"),
}
const assignment: Policy.Assignment = {
	entry: "forecast",
	artifact,
	tier: "untrusted",
	grants: [
		{
			_tag: "Http",
			id: "weather",
			origin: "https://weather.example",
			credential: "WEATHER_KEY",
		},
	],
}
const description = {
	projection: "mcp/tools",
	service: "forecast",
	operation: "read@1",
	value: {
		name: "forecast",
		title: "Forecast",
		description: "Read the weather",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
		output: "json",
	},
} satisfies Trust.Projection
const approved = Effect.gen(function* () {
	yield* Policy.install({ version: "1", entries: [assignment] })
	yield* Policy.bind("forecast", "candidate", artifact, ["forecast"])
	yield* Policy.publish([description])
	const expected = yield* Policy.statement("forecast", artifact)
	const record = yield* Policy.review({ expected, who: "operator@example" })
	yield* Policy.approve(record)
	return { record }
})
it.effect(
	"blocks unknown and unapproved artifacts before calls are admitted",
	() =>
		Effect.gen(function* () {
			yield* Policy.install({ version: "1", entries: [assignment] })
			const missing = yield* Policy.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(missing.reason, "UnknownArtifact")
			yield* Policy.bind("forecast", "candidate", artifact, ["forecast"])
			assert.equal(
				(yield* Policy.check("forecast", "candidate").pipe(Effect.flip)).reason,
				"MissingApproval",
			)
		}).pipe(run),
)
for (const field of [
	"name",
	"title",
	"description",
	"readOnlyHint",
	"destructiveHint",
	"idempotentHint",
	"openWorldHint",
	"output",
] as const)
	it.effect(
		"invalidates approval when exact tool metadata changes: " + field,
		() =>
			Effect.gen(function* () {
				yield* approved
				yield* Policy.check("forecast", "candidate")
				const value = description.value[field]
				const metadata = {
					...description.value,
					[field]:
						typeof value === "boolean"
							? !value
							: field === "output"
								? ("void" as const)
								: value + " ",
				}
				yield* Policy.publish([{ ...description, value: metadata }])
				assert.equal(
					(yield* Policy.check("forecast", "candidate").pipe(Effect.flip))
						.reason,
					"ChangedStatement",
				)
				const expected = yield* Policy.statement("forecast", artifact)
				const record = yield* Policy.review({
					expected,
					who: "reviewer@example",
				})
				yield* Policy.approve(record)
				yield* Policy.check("forecast", "candidate")
			}).pipe(run),
	)
it.effect(
	"snapshots policy and approval data and does not expose mutable registry state",
	() =>
		Effect.gen(function* () {
			const { record } = yield* approved
			const statement = yield* Policy.statement("forecast", artifact)
			const altered = { ...statement, policyVersion: "2" }
			assert.equal(
				(yield* Policy.review({ expected: altered, who: "operator" }).pipe(
					Effect.flip,
				)).reason,
				"ChangedStatement",
			)
			assert.isTrue(Schema.is(Policy.Approval)(record))
			const changed = { ...artifact, digest: String.repeat(64)("b") }
			assert.equal(
				(yield* Policy.bind("forecast", "other", changed, ["forecast"]).pipe(
					Effect.flip,
				))._tag,
				"Unapproved",
			)
		}).pipe(run),
)
it.effect(
	"revocation fences calls and waits for all owners; later owners also terminate",
	() =>
		Effect.gen(function* () {
			yield* approved
			const closed = yield* Ref.make(0)
			const terminate = Ref.update(closed, (n) => n + 1)
			yield* Policy.onRevoke("forecast", "candidate", terminate)
			yield* Policy.revoke(["weather"])
			assert.equal(
				(yield* Policy.check("forecast", "candidate").pipe(Effect.flip)).reason,
				"Revoked",
			)
			const first = yield* Ref.get(closed)
			assert.equal(first, 1)
			yield* Policy.onRevoke("forecast", "candidate", terminate)
			const second = yield* Ref.get(closed)
			assert.equal(second, 2)
			const expected = yield* Policy.statement("forecast", artifact)
			assert.equal(
				(yield* Policy.review({ expected, who: "operator" }).pipe(Effect.flip))
					.reason,
				"Revoked",
			)
			const override = yield* Policy.review({
				expected,
				who: "operator",
				overrideRevocations: true,
			})
			yield* Policy.approve(override)
			yield* Policy.check("forecast", "candidate")
			yield* Policy.revoke(["weather"])
			assert.equal(
				(yield* Policy.check("forecast", "candidate").pipe(Effect.flip)).reason,
				"Revoked",
			)
		}).pipe(run),
)

for (const tier of ["own", "trusted", "untrusted"] as const)
	it.effect("requires artifact approval for the " + tier + " tier", () =>
		Effect.gen(function* () {
			yield* Policy.install({
				version: "1",
				entries: [{ ...assignment, tier }],
			})
			yield* Policy.bind("forecast", "candidate", artifact, [])
			const error = yield* Policy.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(error.reason, "MissingApproval")
		}).pipe(run),
	)
for (const changed of ["version", "grants", "artifact"] as const)
	it.effect("invalidates persisted approval after a change to " + changed, () =>
		Effect.gen(function* () {
			const previous: Policy.Approval = {
				statement: { assignment, policyVersion: "1", projections: [] },
				who: "operator",
				at: 0,
				overrideRevocations: false,
			}
			const identity =
				changed === "artifact"
					? { ...artifact, digest: String.repeat(64)("b") }
					: artifact
			const next = {
				...assignment,
				artifact: identity,
				grants: changed === "grants" ? [] : assignment.grants,
			}
			yield* Policy.install(
				{ version: changed === "version" ? "2" : "1", entries: [next] },
				[previous],
			)
			yield* Policy.bind("forecast", "candidate", identity, [])
			const error = yield* Policy.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(error.reason, "ChangedStatement")
		}).pipe(run),
	)
it.effect(
	"closing policy fences calls and terminates both existing and late owners",
	() =>
		Effect.gen(function* () {
			const owner = yield* Scope.make()
			yield* Policy.install({ version: "1", entries: [assignment] }).pipe(
				Scope.provide(owner),
			)
			yield* Policy.bind("forecast", "candidate", artifact, [])
			const count = yield* Ref.make(0)
			yield* Policy.onRevoke(
				"forecast",
				"candidate",
				Ref.update(count, (n) => n + 1),
			)
			yield* Scope.close(owner, Exit.void)
			const error = yield* Policy.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(error.reason, "Closed")
			yield* Policy.onRevoke(
				"forecast",
				"candidate",
				Ref.update(count, (n) => n + 1),
			)
			const closed = yield* Ref.get(count)
			assert.equal(closed, 2)
		}).pipe(run),
)
it.effect(
	"retains every termination cause while keeping revoked admission closed",
	() =>
		Effect.gen(function* () {
			yield* approved
			for (const message of ["first cleanup", "second cleanup"])
				yield* Policy.onRevoke(
					"forecast",
					"candidate",
					Policy.PolicyError.make({ message, cause: Cause.die(message) }),
				)
			const failure = yield* Policy.revoke(["weather"]).pipe(Effect.flip)
			assert.isDefined(failure.cause)
			assert.equal(failure.cause?.reasons.length, 2)
			const blocked = yield* Policy.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(blocked.reason, "Revoked")
		}).pipe(run),
)

it.effect(
	"restores approved projection facts before mounting views on an overridden restart",
	() =>
		Effect.gen(function* () {
			const record: Policy.Approval = {
				statement: {
					assignment,
					policyVersion: "1",
					projections: [description],
				},
				who: "emergency operator",
				at: 1,
				overrideRevocations: true,
			}
			yield* Policy.install(
				{ version: "1", entries: [assignment] },
				[record],
				["weather"],
			)
			yield* Policy.bind("forecast", "candidate", artifact, ["forecast"])
			const terminated = yield* Ref.make(false)
			yield* Policy.onRevoke("forecast", "candidate", Ref.set(terminated, true))
			const stopped = yield* Ref.get(terminated)
			assert.isFalse(stopped)
			yield* Policy.check("forecast", "candidate")
			yield* Policy.publish([description])
			yield* Policy.check("forecast", "candidate")
			yield* Policy.revoke(["unrelated"])
			const unrelated = yield* Ref.get(terminated)
			assert.isFalse(unrelated)
			yield* Policy.check("forecast", "candidate")
			yield* Policy.revoke(["weather"])
			const explicitlyRevoked = yield* Ref.get(terminated)
			assert.isTrue(explicitlyRevoked)
			const denied = yield* Policy.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(denied.reason, "Revoked")
		}).pipe(run),
)

it.effect(
	"releases failed and never-started bindings without taking over another attempt",
	() =>
		Effect.gen(function* () {
			yield* Policy.install({
				version: "1",
				entries: [assignment, { ...assignment, entry: "replacement" }],
			})
			for (let index = 0; index < 30; index++) {
				yield* Effect.scoped(
					Policy.bind("forecast", `candidate-${index}`, artifact, ["forecast"]),
				)
				const observed1 = yield* Policy.bindings
				assert.equal(observed1, 0)
			}
			const failed = yield* Effect.scoped(
				Policy.bind("forecast", "failed", artifact, ["forecast"]).pipe(
					Effect.andThen(Effect.die("Allocation failed")),
				),
			).pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(failed))
			const observed2 = yield* Policy.bindings
			assert.equal(observed2, 0)
			const first = yield* Scope.make()
			const second = yield* Scope.make()
			yield* Policy.bind("forecast", "same", artifact, ["forecast"]).pipe(
				Scope.provide(first),
			)
			yield* Policy.bind("forecast", "same", artifact, ["forecast"]).pipe(
				Scope.provide(second),
			)
			yield* Scope.close(first, Exit.void)
			const observed3 = yield* Policy.bindings
			assert.equal(observed3, 1)
			const conflict = yield* Effect.scoped(
				Policy.bind("replacement", "next", artifact, ["forecast"]),
			).pipe(Effect.flip)
			assert.equal(conflict._tag, "PolicyError")
			yield* Scope.close(second, Exit.void)
			yield* Policy.bind("replacement", "next", artifact, ["forecast"])
			const observed4 = yield* Policy.bindings
			assert.equal(observed4, 1)
		}).pipe(run),
)

it.effect(
	"bounds all revocation owners with the shared termination limits",
	() =>
		Effect.gen(function* () {
			yield* approved
			const owner = yield* Scope.make()
			const entered = yield* Deferred.make<void>()
			const last = yield* Deferred.make<void>()
			const started = yield* Ref.make(0)
			const active = yield* Ref.make(0)
			const maximum = yield* Ref.make(0)
			const stop = Effect.acquireUseRelease(
				Ref.updateAndGet(active, (n) => n + 1).pipe(
					Effect.tap((n) =>
						Ref.update(maximum, (previous) => Math.max(previous, n)),
					),
					Effect.tap(() =>
						Ref.updateAndGet(started, (n) => n + 1).pipe(
							Effect.flatMap((n) =>
								n === Policy.termination.concurrency
									? Deferred.succeed(entered, undefined)
									: n === Policy.termination.concurrency + 1
										? Deferred.succeed(last, undefined)
										: Effect.void,
							),
						),
					),
				),
				() => Effect.never,
				() => Ref.update(active, (n) => n - 1),
			)
			for (let index = 0; index < Policy.termination.concurrency + 1; index++)
				yield* Policy.onRevoke("forecast", "candidate", stop).pipe(
					Scope.provide(owner),
				)
			const pending = yield* Policy.revoke(["weather"]).pipe(
				Effect.flip,
				Effect.forkScoped,
			)
			yield* Deferred.await(entered)
			yield* TestClock.adjust(Policy.termination.timeout)
			yield* Deferred.await(last)
			yield* TestClock.adjust(Policy.termination.timeout)
			const result = yield* Fiber.join(pending)
			yield* Scope.close(owner, Exit.void)
			assert.include(Cause.pretty(result.cause!), "Timeout")
			const observed5 = yield* Ref.get(started)
			assert.equal(observed5, Policy.termination.concurrency + 1)

			const observed6 = yield* Ref.get(maximum)

			assert.equal(observed6, Policy.termination.concurrency)
			const observed7 = yield* Ref.get(active)
			assert.equal(observed7, 0)
		}).pipe(run),
)

it.effect(
	"restores the latest published facts from multiple journaled approvals",
	() =>
		Effect.gen(function* () {
			const old = {
				...description,
				value: { ...description.value, description: "Earlier description" },
			}
			const records: ReadonlyArray<Policy.Approval> = Array.map(
				[old, description],
				(projection) => ({
					statement: {
						assignment,
						policyVersion: "1",
						projections: [projection],
					},
					who: "Operator",
					at: 1,
					overrideRevocations: false,
				}),
			)
			yield* Policy.install({ version: "1", entries: [assignment] }, records)
			yield* Policy.bind("forecast", "candidate", artifact, ["forecast"])
			yield* Policy.check("forecast", "candidate")
			yield* Policy.publish([description])
			yield* Policy.check("forecast", "candidate")
			const statement = yield* Policy.statement("forecast", artifact)
			assert.deepEqual(statement.projections, [description])
		}).pipe(run),
)
