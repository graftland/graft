import {
	Array,
	Cause,
	Effect,
	Exit,
	HashMap,
	Option,
	Record,
	Ref,
	Schema,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import {
	applyChanges,
	decodeManifest,
	encodeManifest,
	type Changes,
} from "../src/manifest.ts"
import { run, setup, success } from "./fixtures.ts"

const edit = Effect.fnUntraced(function* (
	original: string,
	changes: Parameters<typeof applyChanges>[1],
) {
	const manifest = yield* decodeManifest(original)
	return yield* encodeManifest(applyChanges(manifest, changes), original)
})

describe("manifest structure", () => {
	it.effect(
		"preserves order and section membership across a large batch of edits",
		() =>
			Effect.gen(function* () {
				const names = Array.makeBy(512, (i) => `dep-${i}`)
				const dependencies = Record.fromEntries(
					Array.map(names, (name) => [name, "1"] as const),
				)
				const encode = Schema.encodeEffect(
					Schema.fromJsonString(Schema.Unknown),
				)
				const original = yield* encode({
					custom: { value: "unchanged" },
					dependencies,
					devDependencies: { shared: "1" },
					optionalDependencies: { shared: "1" },
				})
				const changes = Record.fromEntries([
					...Array.map(
						names,
						(name, i) => [name, i % 2 === 0 ? null : "2"] as const,
					),
					["shared", "3"] as const,
					["added-b", "1"] as const,
					["added-a", "1"] as const,
				])
				const output = yield* edit(original, changes)
				const expected = yield* encode({
					custom: { value: "unchanged" },
					dependencies: Record.fromEntries([
						...Array.flatMap(names, (name, i) =>
							i % 2 === 0 ? [] : [[name, "2"] as const],
						),
						["added-b", "1"] as const,
						["added-a", "1"] as const,
					]),
					devDependencies: { shared: "3" },
					optionalDependencies: { shared: "3" },
				})
				assert.strictEqual(output, expected)
			}).pipe(run),
	)

	it.effect(
		"removes dependencies whose names also exist on Object.prototype",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				yield* write(
					"package.json",
					'{"dependencies":{"constructor":"1","toString":"2","valueOf":"3","keep":"workspace:*"}}',
				)
				const pm = yield* manager(() => success)
				const result = yield* pm.install({
					constructor: null,
					toString: null,
					valueOf: null,
				})
				assert.deepStrictEqual(
					Array.map(result.removed, (change) => change.name),
					["constructor", "toString", "valueOf"],
				)
				const text = yield* read("package.json")
				assert.strictEqual(text, '{"dependencies":{"keep":"workspace:*"}}')
			}).pipe(run),
	)

	it.effect(
		"edits only the effective occurrence of a duplicated dependency section",
		() =>
			Effect.gen(function* () {
				const original =
					'{"dependencies":{"ignored":"workspace:*"},"dependencies":{"active":"1"}}'
				const updated = yield* edit(original, { active: "2" })
				assert.strictEqual(
					updated,
					'{"dependencies":{"ignored":"workspace:*"},"dependencies":{"active":"2"}}',
				)
			}),
	)

	it.effect(
		"removes all duplicate dependency keys so an older value cannot reappear",
		() =>
			Effect.gen(function* () {
				const original =
					'{"dependencies":{"alias":{},"\\u0061lias":"1","keep":"2"}}'
				const updated = yield* edit(original, { alias: null })
				assert.strictEqual(updated, '{"dependencies":{"keep":"2"}}')
			}),
	)

	it.effect(
		"preserves escaped section names and nested empty custom objects and arrays",
		() =>
			Effect.gen(function* () {
				const original =
					'{"custom":[{},[],[{},[]],{"nested":{"items":[]}}],"\\u0064ependencies": { "alias":"npm:actual@1" }}'
				const updated = yield* edit(original, { alias: "npm:actual@2" })
				assert.strictEqual(
					updated,
					'{"custom":[{},[],[{},[]],{"nested":{"items":[]}}],"\\u0064ependencies": { "alias":"npm:actual@2" }}',
				)
			}),
	)

	it.effect(
		"handles an empty effective section after shadowed non-object JSON values",
		() =>
			Effect.gen(function* () {
				for (const shadowed of ["[]", "{}", "null", "[{},[]]", '"ignored"']) {
					const original = `{"dependencies":${shadowed},"dependencies":{},"custom":[]}`
					const updated = yield* edit(original, { added: "1" })
					const decoded = yield* decodeManifest(updated)
					assert.deepStrictEqual(decoded.dependencies, { added: "1" })
				}
			}),
	)

	it.effect(
		"rejects invalid manifest shapes before writing or starting a process",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				const calls = yield* Ref.make(0)
				yield* write("package.json", "{}")
				const pm = yield* manager(() =>
					Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(success)),
				)
				for (const original of [
					"[]",
					"null",
					'"manifest"',
					"1",
					'{"dependencies":[]}',
					'{"dependencies":{"nested":{}}}',
					'{"dependencies":{"nested":[]}}',
					"{/* comment */}",
					'{"dependencies": {',
				]) {
					yield* write("package.json", original)
					const exit = yield* Effect.exit(pm.install({ added: "1" }))
					assert(Exit.isFailure(exit), original)
					assert.strictEqual(
						Option.getOrThrow(Cause.findErrorOption(exit.cause))._tag,
						"SchemaError",
					)
					const after = yield* read("package.json")
					assert.strictEqual(after, original)
				}
				const spawned = yield* Ref.get(calls)
				assert.strictEqual(spawned, 0)
			}).pipe(run),
	)

	it.effect(
		"treats prototype-named dependencies as ordinary keys in state",
		() =>
			Effect.gen(function* () {
				const { write, manager } = yield* setup
				yield* write(
					"package.json",
					'{"dependencies":{"constructor":"1","toString":"2"}}',
				)
				const pm = yield* manager(() => success)
				const state = yield* pm.readState
				assert.strictEqual(
					Option.getOrThrow(HashMap.get(state, "constructor")).spec,
					"1",
				)
				assert.strictEqual(
					Option.getOrThrow(HashMap.get(state, "toString")).spec,
					"2",
				)
			}).pipe(run),
	)
	it.effect("preserves a leading BOM while editing the manifest", () =>
		Effect.gen(function* () {
			const { fs, path, directory, write, manager } = yield* setup
			const file = path.join(directory, "package.json")
			const original = '\uFEFF{"dependencies":{"old":"1"}}\r\n'
			yield* write("package.json", original)
			const pm = yield* manager(() => success)
			yield* pm.install({})
			const unchanged = yield* fs.readFile(file)
			assert.deepStrictEqual(
				Array.fromIterable(unchanged),
				Array.fromIterable(new TextEncoder().encode(original)),
			)
			yield* pm.install({ old: "2" })
			const updated = yield* fs.readFile(file)
			assert.deepStrictEqual(
				Array.fromIterable(updated),
				Array.fromIterable(
					new TextEncoder().encode('\uFEFF{"dependencies":{"old":"2"}}\r\n'),
				),
			)
		}).pipe(run),
	)
	it.effect(
		"rejects invalid UTF-8 instead of replacing bytes in an unrelated field",
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, manager } = yield* setup
				yield* write("package.json", "{}")
				const calls = yield* Ref.make(0)
				const pm = yield* manager(() =>
					Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(success)),
				)
				const file = path.join(directory, "package.json")
				const bytes = new Uint8Array([
					...new TextEncoder().encode('{"custom":"'),
					0xff,
					...new TextEncoder().encode('"}'),
				])
				yield* fs.writeFile(file, bytes)
				const exit = yield* Effect.exit(pm.install({}))
				assert(Exit.isFailure(exit))
				assert.strictEqual(
					Option.getOrThrow(Cause.findErrorOption(exit.cause))._tag,
					"PlatformError",
				)
				const after = yield* fs.readFile(file)
				assert.deepStrictEqual(
					Array.fromIterable(after),
					Array.fromIterable(bytes),
				)
				const spawned = yield* Ref.get(calls)
				assert.strictEqual(spawned, 0)
			}).pipe(run),
	)

	it.effect(
		"matches the immutable manifest model across edits and repeated executions",
		() =>
			Effect.gen(function* () {
				const sources = [
					"{}",
					"{ }",
					"{\n}",
					"\uFEFF{}\r\n",
					'{"custom":[{},[],{"x":[null,true,false,-1.2e3]}],"dependencies":{}}',
					'{"dependencies":{"constructor":"1","toString":"2","old":"3"}}',
					'{"dependencies":{"old":[],"old":"1"},"devDependencies":{"old":"2"},"optionalDependencies":{"old":"3"}}',
					'{"dependencies":null,"dependencies":{"old":"1"},"custom":{}}',
					'{"dependencies" : { "\\u006fld" : "1" , "keep" : "workspace:*" } }',
				]
				const changes: ReadonlyArray<Changes> = [
					{},
					{ old: "4" },
					{ old: null },
					{ constructor: null, toString: null },
					{ added: "file:../local", alias: "npm:actual@1", zed: "1" },
				]
				for (const original of sources) {
					for (const change of changes) {
						const before = yield* decodeManifest(original)
						const expected = applyChanges(before, change)
						const program = encodeManifest(expected, original)
						const outputs = yield* Effect.all([program, program, program], {
							concurrency: 3,
						})
						for (const output of outputs) {
							const decoded = yield* decodeManifest(output)
							assert.deepStrictEqual(decoded, expected)
							const again = yield* edit(output, change)
							assert.strictEqual(again, output)
						}
					}
				}
			}),
	)
})
