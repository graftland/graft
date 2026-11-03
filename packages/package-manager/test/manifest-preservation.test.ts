import { assert, describe, it } from "@effect/vitest"
import { Effect, HashMap, Option, String } from "effect"
import { run, setup, success } from "./fixtures.ts"

describe("manifest preservation", () => {
	it.effect(
		"keeps an unchanged manifest byte-for-byte, including a missing removal",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				const original =
					'{"name":"app", "custom":{"number":1e3}, "dependencies":{"local":"workspace:*"}}\n'
				yield* write("package.json", original)
				const pm = yield* manager(() => success)
				yield* pm.install({})
				const observed1 = yield* read("package.json")
				assert.strictEqual(observed1, original)
				yield* pm.install({ missing: null, local: "workspace:*" })
				const observed2 = yield* read("package.json")
				assert.strictEqual(observed2, original)
			}).pipe(run),
	)

	it.effect(
		"updates only the requested spec without reordering or reformatting user content",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				const original =
					'{\r\n\t"name": "app",\r\n\t"custom": { "number": 1e3, "escaped": "\\u0061" },\r\n\t"dependencies": { "alias": "npm:actual@^1", "local": "workspace:*" },\r\n\t"scripts": { "test": "custom" }\r\n}\r\n'
				yield* write("package.json", original)
				const pm = yield* manager(() => success)
				yield* pm.install({ alias: "npm:actual@^2" })
				const observed3 = yield* read("package.json")
				assert.strictEqual(
					observed3,
					String.replace("npm:actual@^1", "npm:actual@^2")(original),
				)
			}).pipe(run),
	)

	it.effect(
		"does not introduce absent dependency sections when removing a package",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				yield* write(
					"package.json",
					'{"name":"app","dependencies":{"old":"1","keep":"file:../keep"}}',
				)
				const pm = yield* manager(() => success)
				yield* pm.install({ old: null })
				const observed4 = yield* read("package.json")
				assert.strictEqual(
					observed4,
					'{"name":"app","dependencies":{"keep":"file:../keep"}}',
				)
			}).pipe(run),
	)

	it.effect(
		"reads aliases by manifest name and retains missing optional and workspace specs",
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, manager } = yield* setup
				yield* write(
					"package.json",
					'{"dependencies":{"alias":"npm:actual@^1","local":"workspace:*"},"optionalDependencies":{"optional":"^2"}}',
				)
				yield* fs.makeDirectory(path.join(directory, "node_modules/alias"), {
					recursive: true,
				})
				yield* write(
					"node_modules/alias/package.json",
					'{"name":"actual","version":"1.2.3"}',
				)
				const pm = yield* manager(() => success)
				const state = yield* pm.readState
				const observed5 = yield* fs.realPath(
					path.join(directory, "node_modules/alias"),
				)
				assert.deepStrictEqual(Option.getOrThrow(HashMap.get(state, "alias")), {
					spec: "npm:actual@^1",
					version: "1.2.3",
					path: observed5,
				})
				assert.deepStrictEqual(
					Option.getOrThrow(HashMap.get(state, "optional")),
					{ spec: "^2", version: undefined, path: undefined },
				)
				assert.strictEqual(
					Option.getOrThrow(HashMap.get(state, "local")).spec,
					"workspace:*",
				)
				assert.strictEqual(HashMap.has(state, "actual"), false)
			}).pipe(run),
	)
	it.effect(
		"edits escaped keys and all dependency sections while preserving nested custom values",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				const original =
					'{ "custom" : [true, null, {"nested": "} , \\"quoted\\""}] , "dependencies" : {"\\u0061lias":"npm:actual@1","last":"1"}, "devDependencies":{"alias":"npm:actual@1"},"optionalDependencies":{"alias":"npm:actual@1"} }'
				yield* write("package.json", original)
				const pm = yield* manager(() => success)
				yield* pm.install({
					alias: "npm:actual@2",
					last: null,
					added: "file:../added",
				})
				const updated = yield* read("package.json")
				assert.strictEqual(
					updated,
					'{ "custom" : [true, null, {"nested": "} , \\"quoted\\""}] , "dependencies" : {"\\u0061lias":"npm:actual@2","added":"file:../added"}, "devDependencies":{"alias":"npm:actual@2"},"optionalDependencies":{"alias":"npm:actual@2"} }',
				)
				yield* pm.install({ alias: null, added: null })
				const removed = yield* read("package.json")
				assert.strictEqual(
					removed,
					'{ "custom" : [true, null, {"nested": "} , \\"quoted\\""}] , "dependencies" : {}, "devDependencies":{},"optionalDependencies":{} }',
				)
			}).pipe(run),
	)
})
