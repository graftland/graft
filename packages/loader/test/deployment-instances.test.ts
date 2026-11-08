import { Array, Effect, Option, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { instances, recordingDeclaration } from "../src/Deployment"
import { NewEntry, type Entry } from "../src/Entry"

const plugin = (id: string, fields: Partial<Entry> = {}): Entry =>
	({ id, name: "./plugin.mjs", ...fields }) as Entry
const group = (
	id: string,
	children: ReadonlyArray<Entry>,
	fields: Partial<Entry> = {},
): Entry =>
	({ id, name: "group", group: true, config: children, ...fields }) as Entry

it.effect("flattens groups into their instances in file order", () =>
	Effect.gen(function* () {
		const found = yield* instances([
			plugin("a"),
			group("g", [plugin("b"), group("h", [plugin("c")])]),
			plugin("off", { disabled: true }),
		])
		assert.deepStrictEqual(
			Array.map(found, (entry) => entry.id),
			["a", "b", "c"],
		)
	}),
)

for (const [field, value] of [
	["isolate", ["app/Key"]],
	["inject", ["app/Key"]],
	["intercept", { "app/Level": "Debug" }],
] as const)
	it.effect(`rejects ${field} on a group as well as on an entry`, () =>
		Effect.gen(function* () {
			const onGroup = yield* Effect.flip(
				instances([group("g", [plugin("b")], { [field]: value })]),
			)
			assert.deepStrictEqual([onGroup.entry, onGroup.field], ["g", field])
			const onEntry = yield* Effect.flip(
				instances([plugin("b", { [field]: value })]),
			)
			assert.deepStrictEqual([onEntry.entry, onEntry.field], ["b", field])
		}),
	)

it.effect("rejects a recording role on a group", () =>
	Effect.gen(function* () {
		const error = yield* instances([
			group("g", [plugin("a")], { recording: { role: "release" } }),
		]).pipe(Effect.flip)
		assert.deepStrictEqual([error.entry, error.field], ["g", "recording"])
	}),
)

it.effect(
	"defaults recording to every other application entry, including nested and disabled entries",
	() =>
		Effect.gen(function* () {
			const read = [
				plugin("audit", { recording: { role: "third-party" } }),
				group("g", [plugin("a"), plugin("off", { disabled: true })]),
				plugin("commands", { cli: true }),
				plugin("b"),
			]
			const active = yield* instances(read)
			const declaration = yield* recordingDeclaration(read, active)
			assert.deepStrictEqual(
				declaration,
				Option.some({
					recorder: "third-party",
					instance: "audit",
					scope: ["a", "off", "b"],
				}),
			)
		}),
)

for (const scope of [[], ["a"]])
	it.effect(
		`preserves an explicit recording scope of ${scope.length} entries`,
		() =>
			Effect.gen(function* () {
				const read = [
					plugin("audit", { recording: { role: "release", scope } }),
					plugin("a"),
					plugin("b"),
				]
				const active = yield* instances(read)
				const declaration = yield* recordingDeclaration(read, active)
				assert.deepStrictEqual(
					declaration,
					Option.some({ recorder: "release", instance: "audit", scope }),
				)
			}),
	)

it.effect(
	"rejects multiple recording declarations, including disabled entries in nested groups",
	() =>
		Effect.gen(function* () {
			const read = [
				plugin("audit", { recording: { role: "release" } }),
				group("g", [
					plugin("other", { disabled: true, recording: { role: "other" } }),
				]),
			]
			const active = yield* instances(read)
			const error = yield* recordingDeclaration(read, active).pipe(Effect.flip)
			assert.equal(error._tag, "DeploymentRecordingInvalid")
			if (error._tag === "DeploymentRecordingInvalid") {
				assert.equal(error.reason, "MultipleRecorders")
				assert.deepStrictEqual(error.entries, ["audit", "other"])
			}
		}),
)

it.effect("rejects a recording declaration on an inactive entry", () =>
	Effect.gen(function* () {
		const read = [
			plugin("audit", { disabled: true, recording: { role: "release" } }),
		]
		const active = yield* instances(read)
		const error = yield* recordingDeclaration(read, active).pipe(Effect.flip)
		assert.equal(error._tag, "DeploymentRecordingInvalid")
		if (error._tag === "DeploymentRecordingInvalid")
			assert.equal(error.reason, "InactiveRecorder")
	}),
)

it("validates the recording role and scope as entry fields", () => {
	const accepts = Schema.is(NewEntry)
	assert.isTrue(
		accepts({ name: "audit", recording: { role: "release", scope: ["a"] } }),
	)
	assert.isFalse(accepts({ name: "audit", recording: {} }))
	assert.isFalse(accepts({ name: "audit", recording: { role: 1 } }))
	assert.isFalse(
		accepts({ name: "audit", recording: { role: "release", scope: [1] } }),
	)
})

it.effect("rejects a contract on a group", () =>
	Effect.gen(function* () {
		const error = yield* instances([
			group("g", [plugin("a")], {
				contract: { artifact: "./contract/index.mjs", module: "consumer.mjs" },
			}),
		]).pipe(Effect.flip)
		assert.deepStrictEqual([error.entry, error.field], ["g", "contract"])
	}),
)
