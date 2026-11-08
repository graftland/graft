import {
	Array,
	Cause,
	Effect,
	FileSystem,
	HashMap,
	HashSet,
	Layer,
	Option,
	Path,
	Schedule,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Kernel } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Control from "../src/Control"
import * as Units from "../src/Units"

const budget = {
	total: 20000,
	startup: 3000,
	probe: 500,
	drain: 500,
	stop: 500,
	terminate: 1000,
}
const fixture = Effect.fn(function* (
	placement: "Worker" | "Process",
	fault: "none" | "ordinary" | "blocked",
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const cache = new URL("../.cache/group-tests/", import.meta.url).pathname
	yield* fs.makeDirectory(cache, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({ directory: cache })
	const entries = yield* Effect.forEach(
		[
			["a", "provider.mjs"],
			["b", "consumer.mjs"],
			["c", "healthy.mjs"],
		] satisfies ReadonlyArray<readonly [string, string]>,
		Effect.fn(function* ([instance, entry]) {
			const artifact = yield* Artifact.capture({
				directory: new URL("./fixtures/group/", import.meta.url).pathname,
				entry,
				store: path.join(directory, "artifacts"),
			})
			const target = Units.target({
				artifact,
				input: { directory, fault },
				placement,
			})
			return { instance, target, colocate: ["shared"] }
		}),
	)
	const layer = Kernel.layer({
		authority: "native-group",
		maxUnits: 8,
		instances: Array.map(entries, (entry) => ({
			id: entry.instance,
			target: entry.target,
		})),
	}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
	return { fs, path, directory, entries, layer }
})
const exists = Effect.fn(function* (directory: string, name: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	return yield* fs.exists(path.join(directory, name)).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("10 millis"),
			until: (value) => value,
		}),
		Effect.timeout("10 seconds"),
	)
})

for (const placement of ["Worker", "Process"] as const) {
	it.live(
		`serves one native ${placement} group with independent member grants and local values, without a fabricated contract (I2, I3, I6, I7)`,
		() =>
			Effect.gen(function* () {
				const f = yield* fixture(placement, "none")
				yield* Effect.gen(function* () {
					const address = yield* Control.serve()
					const client = yield* Control.connect(address)
					const handle = yield* client.submit({
						operations: Array.map(f.entries, (entry) => ({
							_tag: "Deploy",
							...entry,
						})),
						strategy: "Restart",
						budget,
					})
					const result = yield* handle.await
					assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
					assert.equal(HashMap.size(result.members), 4)
					assert.isTrue(
						HashMap.every(
							result.members,
							(member) => member.healthy && member.matchesTarget,
						),
					)
					const observed1 = yield* client.units
					const units = Array.filter(
						observed1,
						(unit) => unit.kind === "Execution" && unit.evidence === "Missing",
					)
					assert.equal(units.length, 1)
					const unit = Option.getOrThrow(Array.head(units))
					assert.equal(HashMap.size(unit.members), 4)
					for (const id of ["a", "a/scope-child", "b", "c"])
						assert.equal(
							Option.getOrThrow(HashMap.get(unit.members, id)).term,
							1,
						)
					const observed2 = yield* f.fs.readFileString(
						f.path.join(f.directory, "active-b-1"),
					)
					assert.equal(observed2, "1")
				}).pipe(Effect.provide(f.layer))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30000,
	)

	it.live(
		`restarts only the failed provider and its local consumer inside a native ${placement} group, retaining a healthy co-resident (I6, I7, F8)`,
		() =>
			Effect.gen(function* () {
				const f = yield* fixture(placement, "ordinary")
				yield* Effect.gen(function* () {
					const observed3 = yield* Control.serve()
					const client = yield* Control.connect(observed3)
					const handle = yield* client.submit({
						operations: Array.map(f.entries, (entry) => ({
							_tag: "Deploy",
							...entry,
						})),
						strategy: "Restart",
						budget,
					})
					assert.equal((yield* handle.await).outcome, "Accepted")
					yield* exists(f.directory, "active-b-1")
					const observed4 = yield* client.units
					const before = Option.getOrThrow(
						Array.findFirst(
							observed4,
							(unit) =>
								unit.kind === "Execution" && unit.evidence === "Missing",
						),
					)
					yield* f.fs.writeFileString(
						f.path.join(f.directory, "fail-a"),
						"trigger",
					)
					yield* exists(f.directory, "failure-a")
					yield* exists(f.directory, "active-b-2")
					yield* exists(f.directory, "active-s-2")
					const observed5 = yield* f.fs.readFileString(
						f.path.join(f.directory, "active-b-2"),
					)
					assert.equal(observed5, "2")
					const observed6 = yield* f.fs.exists(
						f.path.join(f.directory, "closed-c-1"),
					)
					assert.isFalse(observed6)
					const observed7 = yield* f.fs.exists(
						f.path.join(f.directory, "active-c-2"),
					)
					assert.isFalse(observed7)
					const observed8 = yield* client.units
					const after = Option.getOrThrow(
						Array.findFirst(observed8, (unit) => unit.id === before.id),
					)
					assert.equal(after.incarnation, before.incarnation)
					assert.equal(after.evidence, "Missing")
					assert.equal(
						Option.getOrThrow(HashMap.get(after.members, "a")).term,
						2,
					)
					assert.equal(
						Option.getOrThrow(HashMap.get(after.members, "b")).term,
						2,
					)
					assert.equal(
						Option.getOrThrow(HashMap.get(after.members, "c")).term,
						1,
					)
					const observed9 = yield* client.get(handle.id)
					const status = Option.getOrThrow(observed9)
					assert.isTrue(
						HashMap.every(status.members, (member) => member.healthy),
					)
				}).pipe(Effect.provide(f.layer))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30000,
	)
}

it.live(
	"terminates a shared native group after a member's blocked teardown and reports every collateral member with exact exit evidence (I6, I7, F9, F11)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture("Worker", "blocked")
			yield* Effect.gen(function* () {
				const observed10 = yield* Control.serve()
				const client = yield* Control.connect(observed10)
				const handle = yield* client.submit({
					operations: Array.map(f.entries, (entry) => ({
						_tag: "Deploy",
						...entry,
					})),
					strategy: "Restart",
					budget,
				})
				const conclusion = yield* handle.await
				assert.equal(conclusion.outcome, "Accepted")
				yield* exists(f.directory, "active-b-1")
				yield* f.fs.writeFileString(
					f.path.join(f.directory, "fail-a"),
					"trigger",
				)
				yield* exists(f.directory, "blocked-a")
				const units = yield* client.units.pipe(
					Effect.repeat({
						schedule: Schedule.spaced("10 millis"),
						until: (units) =>
							Array.some(
								units,
								(unit) =>
									unit.kind === "Execution" && unit.evidence === "Exited",
							),
					}),
					Effect.timeout("10 seconds"),
				)
				const unit = Option.getOrThrow(
					Array.findFirst(units, (unit) => unit.kind === "Execution"),
				)
				assert.equal(unit.evidence, "Exited")
				assert.equal(unit.cleanup._tag, "Unknown")
				assert.sameMembers(Array.fromIterable(HashMap.keys(unit.members)), [
					"a",
					"a/scope-child",
					"b",
					"c",
				])
				const observed11 = yield* client.get(handle.id)
				const status = Option.getOrThrow(observed11)
				assert.isTrue(
					HashMap.every(status.members, (member) => !member.healthy),
				)
				assert.deepEqual(status.conclusion, Option.some(conclusion))
				assert.equal(HashSet.size(status.unconfirmedUnits), 0)
			}).pipe(Effect.provide(f.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
