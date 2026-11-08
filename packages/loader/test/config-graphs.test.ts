import {
	Array,
	Cause,
	DateTime,
	Effect,
	Exit,
	FileSystem,
	Option,
	Path,
	Schema,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, type Fork } from "@graftland/graft"

import { Entry, Group, Include, Loader, Tree } from "../src/index.ts"
import { fixture, loaderService, run } from "./utils.ts"

const cycle = () => {
	const value: Record<string, unknown> = { text: "cycle" }
	value["self"] = value
	return value
}

const flatten = (
	trees: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Array.flatMap(trees, (tree) => [tree, ...flatten(tree.children)])
const expectCyclicEntry = Effect.fn("expectCyclicEntry")(function* (
	name: string,
) {
	const trees = yield* Stream.runHead(Graft.forks)
	const node = Option.getOrThrow(
		Array.findFirst(
			flatten(Option.getOrThrow(trees)),
			(node) => node.name === name && node.state._tag === "Failed",
		),
	)
	assert(node.state._tag === "Failed")
	const error = Option.getOrThrow(Cause.findErrorOption(node.state.cause))
	assert(Schema.is(Entry.CyclicConfig)(error))
})

describe("configuration graphs", () => {
	it.effect("isolates a cyclic group when Group is used without Loader", () =>
		Effect.gen(function* () {
			const children: Entry.Entry[] = []
			children.push({
				id: "loop",
				name: "group",
				group: true,
				config: children,
			})
			yield* run({ healthy: fixture("started") })((journal) =>
				Effect.gen(function* () {
					const group = yield* Graft.plugin(Group.Group, [
						{ id: "cyclic", name: "group", group: true, config: children },
						{ id: "healthy", name: "healthy" },
					])
					yield* group.await
					yield* group.stable
					yield* journal.expect(["started"])
				}),
			)
		}),
	)
	it.effect(
		"repairs an anchored cyclic config while preserving another entry's old value",
		() =>
			run()((journal) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = path.join(directory, "graft.yml")
					yield* fs.writeFileString(
						file,
						"- id: original\n  name: echo\n  config: &cycle { text: cycle, self: *cycle }\n- id: copy\n  name: echo\n  config: *cycle\n",
					)
					yield* Graft.plugin(Include.Include, { path: file })
					const loader = yield* loaderService
					yield* loader.ready
					yield* loader.update("original", { config: { text: "repaired" } })
					yield* loader.ready
					yield* expectCyclicEntry("echo")
					yield* journal.expect(["start repaired"])
					yield* loader.update("copy", { config: { text: "also repaired" } })
					yield* loader.ready
					yield* journal.expect(["start repaired", "start also repaired"])
				}),
			),
	)
	it.effect(
		"isolates a cyclic YAML entry and permits later edits and removal",
		() =>
			run()((journal) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = path.join(directory, "graft.yml")
					yield* fs.writeFileString(
						file,
						"- name: echo\n  config: &cycle { text: cycle, self: *cycle }\n- id: healthy\n  name: echo\n  config: { text: healthy }\n",
					)
					yield* Graft.plugin(Include.Include, { path: file })
					const loader = yield* loaderService
					yield* loader.ready
					yield* expectCyclicEntry("echo")
					yield* journal.expect(["start healthy"])
					const initial = yield* loader.entries
					const bad = Option.getOrThrow(Array.head(initial))
					// Comparing and serializing an unchanged cycle must also terminate.
					yield* loader.update("healthy", { config: { text: "updated" } })
					yield* loader.ready
					yield* loader.remove(bad.id)
					yield* loader.ready
					yield* journal.expect([
						"start healthy",
						"stop healthy",
						"start updated",
					])
				}),
			),
	)

	it.effect(
		"recovers after cyclic in-memory configs and intercepts are replaced",
		() =>
			run()((journal) =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [])
					const loader = yield* loaderService
					yield* loader.create({ id: "cyclic", name: "echo", config: cycle() })
					yield* loader.ready
					yield* expectCyclicEntry("echo")
					yield* loader.update("cyclic", { config: cycle() })
					yield* loader.ready
					yield* loader.update("cyclic", { config: { text: "recovered" } })
					yield* loader.ready
					yield* journal.expect(["start recovered"])
					yield* loader.update("cyclic", { intercept: { settings: cycle() } })
					yield* loader.ready
					yield* expectCyclicEntry("echo")
					yield* loader.update("cyclic", { intercept: { settings: cycle() } })
					yield* loader.ready
					yield* loader.remove("cyclic")
					yield* loader.ready
				}),
			),
	)

	it.effect("accepts shared acyclic data and preserves opaque values", () =>
		Effect.gen(function* () {
			const date = DateTime.toDateUtc(
				DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
			)
			const shared = { value: 1 }
			const resolved = yield* Entry.resolveEnv({
				date,
				left: shared,
				right: shared,
			})
			assert.deepStrictEqual(resolved, {
				date,
				left: { value: 1 },
				right: { value: 1 },
			})
			const failure = yield* Effect.exit(Entry.resolveEnv(cycle()))
			assert(Exit.isFailure(failure))
			assert.strictEqual(
				Option.getOrThrow(Cause.findErrorOption(failure.cause))._tag,
				"CyclicConfig",
			)
		}),
	)

	it.effect(
		"rejects cycles in the group topology before traversing entries",
		() =>
			run()(() =>
				Effect.gen(function* () {
					const entries: Entry.Entry[] = []
					entries.push({
						id: "group",
						name: "group",
						group: true,
						config: entries,
					})
					const checked = yield* Effect.exit(
						Effect.fromResult(Tree.validate(entries)),
					)
					assert(Exit.isFailure(checked))
					const edited = yield* Effect.exit(
						Effect.fromResult(
							Tree.apply(entries, Tree.Op.Remove({ id: "missing" })),
						),
					)
					assert(Exit.isFailure(edited))
					const fork = yield* Graft.plugin(Loader.plugin, entries)
					const error = yield* Effect.flip(fork.await)
					assert.strictEqual(error._tag, "InvalidOperation")
				}),
			),
	)
})
