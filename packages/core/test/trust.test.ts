import { Cause, Effect, Exit, Ref, Schema, Scope, String } from "effect"
import { assert, it } from "@effect/vitest"

import { Trust } from "../src/index"
import { run } from "./utils"

const artifact = {
	package: "@example/untrusted",
	digest: String.repeat(64)("a"),
}
const assignment: Trust.Assignment = {
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
const description: Trust.Description = {
	service: "forecast",
	operation: "read@1",
	metadata: {
		name: "forecast",
		title: "Forecast",
		description: "Read the weather",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
		output: "json",
	},
}
const approved = Effect.gen(function* () {
	yield* Trust.install({ version: "1", entries: [assignment] })
	yield* Trust.bind("forecast", "candidate", artifact, ["forecast"])
	const owner = {}
	yield* Trust.describe(owner, [description])
	const expected = yield* Trust.statement("forecast", artifact)
	const record = yield* Trust.review({ expected, who: "operator@example" })
	yield* Trust.approve(record)
	return { owner, record }
})
it.effect(
	"blocks unknown and unapproved artifacts before calls are admitted",
	() =>
		Effect.gen(function* () {
			yield* Trust.install({ version: "1", entries: [assignment] })
			const missing = yield* Trust.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(missing.reason, "UnknownArtifact")
			yield* Trust.bind("forecast", "candidate", artifact, ["forecast"])
			assert.equal(
				(yield* Trust.check("forecast", "candidate").pipe(Effect.flip)).reason,
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
				const { owner } = yield* approved
				yield* Trust.check("forecast", "candidate")
				const value = description.metadata[field]
				const metadata = {
					...description.metadata,
					[field]:
						typeof value === "boolean"
							? !value
							: field === "output"
								? ("void" as const)
								: value + " ",
				}
				yield* Trust.describe(owner, [{ ...description, metadata }])
				assert.equal(
					(yield* Trust.check("forecast", "candidate").pipe(Effect.flip))
						.reason,
					"ChangedStatement",
				)
				const expected = yield* Trust.statement("forecast", artifact)
				const record = yield* Trust.review({
					expected,
					who: "reviewer@example",
				})
				yield* Trust.approve(record)
				yield* Trust.check("forecast", "candidate")
			}).pipe(run),
	)
it.effect(
	"snapshots policy and approval data and does not expose mutable registry state",
	() =>
		Effect.gen(function* () {
			const { record } = yield* approved
			const statement = yield* Trust.statement("forecast", artifact)
			const altered = { ...statement, policyVersion: "2" }
			assert.equal(
				(yield* Trust.review({ expected: altered, who: "operator" }).pipe(
					Effect.flip,
				)).reason,
				"ChangedStatement",
			)
			assert.isTrue(Schema.is(Trust.Approval)(record))
			const changed = { ...artifact, digest: String.repeat(64)("b") }
			assert.equal(
				(yield* Trust.bind("forecast", "other", changed, ["forecast"]).pipe(
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
			yield* Trust.onRevoke("forecast", "candidate", terminate)
			yield* Trust.revoke(["weather"])
			assert.equal(
				(yield* Trust.check("forecast", "candidate").pipe(Effect.flip)).reason,
				"Revoked",
			)
			const first = yield* Ref.get(closed)
			assert.equal(first, 1)
			yield* Trust.onRevoke("forecast", "candidate", terminate)
			const second = yield* Ref.get(closed)
			assert.equal(second, 2)
			const expected = yield* Trust.statement("forecast", artifact)
			assert.equal(
				(yield* Trust.review({ expected, who: "operator" }).pipe(Effect.flip))
					.reason,
				"Revoked",
			)
			const override = yield* Trust.review({
				expected,
				who: "operator",
				overrideRevocations: true,
			})
			yield* Trust.approve(override)
			yield* Trust.check("forecast", "candidate")
			yield* Trust.revoke(["weather"])
			assert.equal(
				(yield* Trust.check("forecast", "candidate").pipe(Effect.flip)).reason,
				"Revoked",
			)
		}).pipe(run),
)

for (const tier of ["own", "trusted", "untrusted"] as const)
	it.effect("requires artifact approval for the " + tier + " tier", () =>
		Effect.gen(function* () {
			yield* Trust.install({ version: "1", entries: [{ ...assignment, tier }] })
			yield* Trust.bind("forecast", "candidate", artifact, [])
			const error = yield* Trust.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(error.reason, "MissingApproval")
		}).pipe(run),
	)
for (const changed of ["version", "grants", "artifact"] as const)
	it.effect("invalidates persisted approval after a change to " + changed, () =>
		Effect.gen(function* () {
			const previous: Trust.Approval = {
				statement: { assignment, policyVersion: "1", descriptions: [] },
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
			yield* Trust.install(
				{ version: changed === "version" ? "2" : "1", entries: [next] },
				[previous],
			)
			yield* Trust.bind("forecast", "candidate", identity, [])
			const error = yield* Trust.check("forecast", "candidate").pipe(
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
			yield* Trust.install({ version: "1", entries: [assignment] }).pipe(
				Scope.provide(owner),
			)
			yield* Trust.bind("forecast", "candidate", artifact, [])
			const count = yield* Ref.make(0)
			yield* Trust.onRevoke(
				"forecast",
				"candidate",
				Ref.update(count, (n) => n + 1),
			)
			yield* Scope.close(owner, Exit.void)
			const error = yield* Trust.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(error.reason, "Closed")
			yield* Trust.onRevoke(
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
				yield* Trust.onRevoke(
					"forecast",
					"candidate",
					Trust.PolicyError.make({ message, cause: Cause.die(message) }),
				)
			const failure = yield* Trust.revoke(["weather"]).pipe(Effect.flip)
			assert.isDefined(failure.cause)
			assert.equal(failure.cause?.reasons.length, 2)
			const blocked = yield* Trust.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(blocked.reason, "Revoked")
		}).pipe(run),
)

it.effect(
	"restarts an explicitly overridden unit while exact description admission stays blocked",
	() =>
		Effect.gen(function* () {
			const record: Trust.Approval = {
				statement: {
					assignment,
					policyVersion: "1",
					descriptions: [description],
				},
				who: "emergency operator",
				at: 1,
				overrideRevocations: true,
			}
			yield* Trust.install(
				{ version: "1", entries: [assignment] },
				[record],
				["weather"],
			)
			yield* Trust.bind("forecast", "candidate", artifact, ["forecast"])
			const terminated = yield* Ref.make(false)
			yield* Trust.onRevoke("forecast", "candidate", Ref.set(terminated, true))
			const stopped = yield* Ref.get(terminated)
			assert.isFalse(stopped)
			const pending = yield* Trust.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(pending.reason, "Revoked")
			yield* Trust.describe({}, [description])
			yield* Trust.check("forecast", "candidate")
			yield* Trust.revoke(["unrelated"])
			const unrelated = yield* Ref.get(terminated)
			assert.isFalse(unrelated)
			yield* Trust.check("forecast", "candidate")
			yield* Trust.revoke(["weather"])
			const explicitlyRevoked = yield* Ref.get(terminated)
			assert.isTrue(explicitlyRevoked)
			const denied = yield* Trust.check("forecast", "candidate").pipe(
				Effect.flip,
			)
			assert.equal(denied.reason, "Revoked")
		}).pipe(run),
)
