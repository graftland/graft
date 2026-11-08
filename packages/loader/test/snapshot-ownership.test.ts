import {
	Array,
	Deferred,
	Effect,
	Fiber,
	Hash,
	Option,
	Queue,
	Ref,
	Result,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Entry, Loader, Tree } from "../src/index.ts"
import { snapshot } from "../src/internal/snapshot.ts"
import { loaderService, run } from "./utils.ts"

it.effect(
	"keeps the accepted target independent from the caller config object",
	() =>
		run()((journal) =>
			Effect.gen(function* () {
				yield* Graft.plugin(Loader.plugin, [])
				const loader = yield* loaderService
				const config = { text: "before" }
				yield* loader.create({ id: "entry", name: "echo", config })
				yield* loader.ready
				config.text = "after"
				yield* loader.update("entry", { config })
				yield* loader.ready
				yield* journal.expect(["start before", "stop before", "start after"])
			}),
		),
)

it("copies and freezes shared and cyclic graphs while keeping opaque identities", () => {
	class Opaque {
		readonly data = { text: "opaque" }
	}
	const opaque = new Opaque()
	const env = new Entry.Env({ name: "GREETING" })
	const shared: Record<string, unknown> = { text: "before" }
	const values = [shared, shared]
	shared["cycle"] = values
	const input = { values, shared, env, opaque }
	const captured = snapshot(input)
	assert.notStrictEqual(captured, input)
	assert.notStrictEqual(captured.shared, shared)
	assert.strictEqual(captured.values[0], captured.shared)
	assert.strictEqual(captured.values[1], captured.shared)
	assert.strictEqual(captured.shared["cycle"], captured.values)
	assert.strictEqual(captured.env, env)
	assert.strictEqual(captured.opaque, opaque)
	assert.isFalse(Object.isFrozen(opaque))
	assert.isFalse(Object.isFrozen(shared))
	assert.isTrue(Object.isFrozen(captured))
	assert.isTrue(Object.isFrozen(captured.values))
	assert.isTrue(Object.isFrozen(captured.shared))
	assert.strictEqual(Reflect.set(captured.shared, "text", "forbidden"), false)
	assert.strictEqual(snapshot(captured), captured)
	shared["text"] = "after"
	assert.strictEqual(captured.shared["text"], "before")
})

it("does not trust a caller's shallow freeze and preserves record and array structure", () => {
	const child = { text: "before" }
	const key = Symbol("metadata")
	const record: Record<PropertyKey, unknown> = Object.create(null)
	Object.defineProperty(record, "__proto__", { value: child, enumerable: true })
	Object.defineProperty(record, key, { value: child })
	const sparse: Array<unknown> = []
	sparse[2] = record
	const captured = snapshot(Object.freeze({ child, sparse }))
	child.text = "after"
	assert.strictEqual(captured.child.text, "before")
	assert.strictEqual(captured.sparse.length, 3)
	assert.isFalse(0 in captured.sparse)
	const copiedRecord = captured.sparse[2]
	assert.isObject(copiedRecord)
	assert.strictEqual(Object.getPrototypeOf(copiedRecord), null)
	assert.strictEqual(
		Reflect.get(copiedRecord as object, "__proto__"),
		captured.child,
	)
	assert.strictEqual(Reflect.get(copiedRecord as object, key), captured.child)
})

it.effect(
	"owns initial data and exposes only frozen targets through entries and changes",
	() =>
		run()((journal) =>
			Effect.gen(function* () {
				const config = { text: "before" }
				const note = { label: "keep" }
				const initial = [{ id: "entry", name: "echo", config, note }]
				yield* Graft.plugin(Loader.plugin, initial)
				const loader = yield* loaderService
				yield* loader.ready
				// Even a caller-owned object whose structural hash was already cached is copied.
				Hash.hash(config)
				config.text = "after"
				note.label = "changed"
				const entries = yield* loader.entries
				const emitted = yield* Stream.runHead(loader.changes)
				assert.strictEqual(Option.getOrThrow(emitted), entries)
				const entry = Option.getOrThrow(Array.head(entries))
				assert.deepStrictEqual(entry.config, { text: "before" })
				assert.deepStrictEqual(entry["note"], { label: "keep" })
				assert.isTrue(Object.isFrozen(entries))
				assert.isTrue(Object.isFrozen(entry))
				assert.isTrue(Object.isFrozen(entry.config))
				assert.isTrue(Object.isFrozen(entry["note"]))
				assert.isFalse(Reflect.set(entries, "0", {}))
				assert.isFalse(Reflect.set(entry, "name", "changed"))
				yield* loader.update("entry", { config })
				yield* loader.ready
				yield* journal.expect(["start before", "stop before", "start after"])
			}),
		),
)

it.effect(
	"captures queued edits before their caller can mutate the submitted data",
	() =>
		run()(() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const current = yield* Ref.make<ReadonlyArray<Entry.Entry>>([])
				yield* Graft.plugin(
					Plugin.make({
						name: "stored",
						apply: () =>
							Loader.start({
								initial: [],
								apply: (op) =>
									Effect.gen(function* () {
										if (op._tag === "Create" && op.entry.id === "gate") {
											yield* Deferred.succeed(entered, undefined)
											yield* Deferred.await(release)
										}
										const previous = yield* Ref.get(current)
										const next = yield* Effect.fromResult(
											Tree.apply(previous, op),
										)
										yield* Ref.set(current, next)
										return next
									}),
								refresh: Effect.succeedNone,
								external: Stream.never,
							}),
					}),
				)
				const loader = yield* loaderService
				const first = yield* loader
					.create({ id: "gate", name: "unused", disabled: true })
					.pipe(Effect.forkChild({ startImmediately: true }))
				yield* Deferred.await(entered)
				const config = { text: "accepted" }
				const queued = yield* loader
					.create({ id: "queued", name: "unused", disabled: true, config })
					.pipe(Effect.forkChild({ startImmediately: true }))
				config.text = "changed"
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(first)
				yield* Fiber.join(queued)
				const entries = yield* loader.entries
				assert.deepStrictEqual(entries[1]?.config, { text: "accepted" })
			}),
		),
)

it.effect("owns targets returned by custom store apply and refresh", () =>
	run()(() =>
		Effect.gen(function* () {
			const notifications = yield* Queue.unbounded<void>()
			const config = { text: "applied" }
			const target = [{ id: "entry", name: "unused", disabled: true, config }]
			yield* Graft.plugin(
				Plugin.make({
					name: "stored",
					apply: () =>
						Loader.start({
							initial: [],
							apply: () => Effect.succeed(target),
							refresh: Effect.succeedSome(target),
							external: Stream.fromQueue(notifications),
						}),
				}),
			)
			const loader = yield* loaderService
			yield* loader.create({ name: "unused" })
			config.text = "refreshed"
			const applied = yield* loader.entries
			assert.deepStrictEqual(applied[0]?.config, { text: "applied" })
			yield* Queue.offer(notifications, undefined)
			const changed = yield* loader.changes.pipe(
				Stream.filter((entries) => !Object.is(entries, applied)),
				Stream.runHead,
			)
			const refreshed = Option.getOrThrow(changed)
			config.text = "later"
			assert.deepStrictEqual(refreshed[0]?.config, { text: "refreshed" })
			assert.isTrue(Object.isFrozen(refreshed[0]?.config))
		}),
	),
)

it.effect("rejects cyclic arrays per entry and reconciles a later repair", () =>
	run()((journal) =>
		Effect.gen(function* () {
			const loop: Array<unknown> = []
			loop[0] = loop
			const result = yield* Effect.result(Entry.resolveEnv(loop))
			assert(Result.isFailure(result))
			assert.strictEqual(result.failure._tag, "CyclicConfig")
			yield* Graft.plugin(Loader.plugin, [
				{ id: "cyclic", name: "echo", config: loop },
				{ id: "healthy", name: "echo", config: { text: "healthy" } },
			])
			const loader = yield* loaderService
			yield* loader.ready
			yield* journal.expect(["start healthy"])
			const entries = yield* loader.entries
			const captured = entries[0]?.config
			assert(Array.isArray(captured))
			assert.strictEqual(captured[0], captured)
			assert.isTrue(Object.isFrozen(captured))
			loop[0] = "changed outside"
			assert.strictEqual(captured[0], captured)
			yield* loader.update("cyclic", { config: { text: "recovered" } })
			yield* loader.ready
			yield* journal.expect(["start healthy", "start recovered"])
		}),
	),
)
