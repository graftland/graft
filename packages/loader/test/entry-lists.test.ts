import { Array, Option, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Entry } from "../src/index"
import { assignIds } from "../src/internal/entryIds"
import { entryLists } from "../src/internal/entryLists"

it("discovers encoded entry lists through fields, arrays, records, unions and shared schemas", () => {
	const schema = Schema.Struct({
		direct: Entry.Entries,
		optional: Schema.optionalKey(Entry.Entries),
		array: Schema.Array(Schema.Struct({ plugins: Entry.Entries })),
		record: Schema.Record(Schema.String, Entry.Entries),
		union: Schema.Union([
			Schema.String,
			Schema.Struct({ plugins: Entry.Entries }),
		]),
	}).pipe(Schema.encodeKeys({ direct: "renamed" }))
	assert.deepEqual(entryLists(schema), [
		["renamed"],
		["optional"],
		["array", "*", "plugins"],
		["record", "*"],
		["union", "plugins"],
	])
	assert.strictEqual(entryLists(schema), entryLists(schema))
})

it("terminates recursive schemas and leaves declarations opaque", () => {
	interface Recursive {
		readonly plugins: ReadonlyArray<Entry.Entry>
		readonly child?: Recursive
	}
	interface Encoded {
		readonly plugins: ReadonlyArray<Entry.NewEntry>
		readonly child?: Encoded
	}
	const recursive: Schema.Codec<Recursive, Encoded> = Schema.Struct({
		plugins: Entry.Entries,
		child: Schema.optionalKey(Schema.suspend(() => recursive)),
	})
	assert.deepEqual(entryLists(recursive), [["plugins"]])
	assert.deepEqual(
		entryLists(
			Schema.declare<Recursive>(
				(value): value is Recursive =>
					typeof value === "object" && value !== null,
			),
		),
		[],
	)
})

it("reserves explicit identities, salts collisions and scopes anonymous occurrences to their parent", () => {
	const input = [
		{ name: "worker" },
		{ name: "worker" },
		{ id: "explicit", name: "worker" },
	]
	const first = assignIds(input, Option.some("host"))
	assert.deepEqual(first, assignIds(input, Option.some("host")))
	assert.notEqual(first[0]?.id, first[1]?.id)
	assert.equal(first[2]?.id, "explicit")
	const collision = assignIds(
		[{ id: first[0]!.id, name: "reserved" }, ...input],
		Option.some("host"),
	)
	assert.notEqual(collision[1]?.id, first[0]?.id)
	assert.notEqual(assignIds(input, Option.some("other"))[0]?.id, first[0]?.id)
	assert.deepEqual(
		Array.map(
			assignIds([{ name: "new" }, ...input], Option.some("host")).slice(1),
			(entry) => entry.id,
		),
		Array.map(first, (entry) => entry.id),
	)
	assert.deepEqual(
		Array.map(
			assignIds(
				[{ name: "worker", disabled: true }, ...input.slice(1)],
				Option.some("host"),
			),
			(entry) => entry.id,
		),
		Array.map(first, (entry) => entry.id),
	)
})
