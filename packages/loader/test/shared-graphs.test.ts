import { assert, it } from "@effect/vitest"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	ConfigProvider,
	Effect,
	MutableList,
	Predicate,
	Record,
	Ref,
	Result,
	Schema,
} from "effect"
import { Entry, Loader, Tree } from "../src/index.ts"
import { equalConfig } from "../src/internal/equalConfig.ts"
import { snapshot } from "../src/internal/snapshot.ts"
import { loaderService, run } from "./utils.ts"

const graph = (depth: number, leaf: unknown = { value: 1 }): unknown =>
	Array.reduce(Array.range(1, depth), leaf, (child) => ({
		left: child,
		right: child,
	}))

const size = (root: unknown) => {
	const seen = new WeakSet<object>()
	const pending = MutableList.make<unknown>()
	MutableList.append(pending, root)
	let count = 0
	while (pending.length > 0) {
		const value = MutableList.take(pending)
		if (
			value === MutableList.Empty ||
			!Predicate.isObjectOrArray(value) ||
			seen.has(value)
		)
			continue
		seen.add(value)
		count++
		for (const child of Record.values(value as Record<string, unknown>))
			MutableList.append(pending, child)
	}
	return count
}

it.effect(
	"preserves shared records and arrays while resolving environment values",
	() =>
		Effect.gen(function* () {
			const shared = [new Entry.Env({ name: "VALUE" })]
			const input = graph(16, { array: shared, other: shared })
			const output = yield* Entry.resolveEnv(input).pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromEnvRecord({ VALUE: "resolved" }),
				),
			)
			assert.strictEqual(size(output), 18)
			const leaf = Array.reduce(Array.range(1, 16), output, (node) => {
				assert(
					Predicate.hasProperty(node, "left") &&
						Predicate.hasProperty(node, "right"),
				)
				assert.strictEqual(node.left, node.right)
				return node.left
			})
			assert(
				Predicate.hasProperty(leaf, "array") &&
					Predicate.hasProperty(leaf, "other"),
			)
			assert.strictEqual(leaf.array, leaf.other)
			assert.deepStrictEqual(leaf.array, ["resolved"])
		}),
)

it.effect(
	"allocates a new identity cache for each execution and after failure",
	() =>
		Effect.gen(function* () {
			const shared = { value: new Entry.Env({ name: "VALUE" }) }
			const resolving = Entry.resolveEnv({ left: shared, right: shared })
			const provide = (value: string) =>
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromEnvRecord({ VALUE: value }),
				)
			const first = yield* resolving.pipe(provide("first"))
			const missing = yield* resolving.pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromEnvRecord({}),
				),
				Effect.exit,
			)
			assert.strictEqual(missing._tag, "Failure")
			const second = yield* resolving.pipe(provide("second"))
			assert.deepStrictEqual(first, {
				left: { value: "first" },
				right: { value: "first" },
			})
			assert.deepStrictEqual(second, {
				left: { value: "second" },
				right: { value: "second" },
			})
			assert.notStrictEqual(first, second)
		}),
)

it.effect(
	"keeps activation and unchanged updates bounded for shared graphs",
	() =>
		Effect.gen(function* () {
			const observed = yield* Ref.make(0)
			const starts = yield* Ref.make(0)
			const plugin = Plugin.make({
				name: "graph",
				config: Schema.Unknown,
				apply: (value) =>
					Ref.set(observed, size(value)).pipe(
						Effect.andThen(Ref.update(starts, (n) => n + 1)),
					),
			})
			yield* run(() => ({ graph: plugin }))(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{ id: "graph", name: "graph", config: graph(16) },
					])
					const loader = yield* loaderService
					yield* loader.ready
					const persisted = yield* loader.entries
					const active = yield* Ref.get(observed)
					assert.strictEqual(size(persisted[0]?.config), 17)
					assert.strictEqual(active, 17)
					yield* loader.update("graph", { config: graph(16) })
					yield* loader.ready
					const count = yield* Ref.get(starts)
					assert.strictEqual(count, 1)
				}),
			)
		}),
)

/** Access counters measure work without relying on wall-clock timings. */
const countedGraph = (depth: number) => {
	let reads = 0
	const value = Array.reduce(Array.range(1, depth), {} as object, (child) => ({
		get left() {
			reads++
			return child
		},
		get right() {
			reads++
			return child
		},
	}))
	return { value, reads: () => reads }
}

it("visits shared containers once when snapshotting and checking cycles", () => {
	const copying = countedGraph(16)
	const copied = snapshot(copying.value)
	assert.strictEqual(copying.reads(), 32)
	assert.strictEqual(size(copied), 17)
	const checking = countedGraph(16)
	assert(Result.isSuccess(Entry.checkAcyclic(checking.value)))
	assert.strictEqual(checking.reads(), 32)
})

it("visits each compared configuration pair once", () => {
	const left = countedGraph(16)
	const right = countedGraph(16)
	assert.isTrue(equalConfig(left.value, right.value))
	assert.strictEqual(left.reads(), 32)
	assert.strictEqual(right.reads(), 32)
})

it("compares values independently of sharing topology and still detects differences", () => {
	const shared = { value: 1 }
	assert.isTrue(
		equalConfig(
			{ left: shared, right: shared },
			{ left: { value: 1 }, right: { value: 1 } },
		),
	)
	assert.isFalse(
		equalConfig(
			{ left: shared, right: shared },
			{ left: { value: 1 }, right: { value: 2 } },
		),
	)
	const left: Record<string, unknown> = { value: 1 }
	left["self"] = left
	const right: Record<string, unknown> = { value: 1 }
	right["self"] = right
	assert.isTrue(equalConfig(left, right))
	right["value"] = 2
	assert.isFalse(equalConfig(left, right))
	assert.isTrue(
		equalConfig(
			new Entry.Env({ name: "VALUE" }),
			new Entry.Env({ name: "VALUE" }),
		),
	)
	assert.isFalse(
		equalConfig(
			new Entry.Env({ name: "VALUE" }),
			new Entry.Env({ name: "OTHER" }),
		),
	)
})

it("checks each shared group list once before rejecting duplicate domain identities", () => {
	let reads = 0
	const group = (child: unknown) => ({
		id: "group",
		name: "group",
		group: true,
		get config() {
			reads++
			return child
		},
	})
	const input = Array.reduce(
		Array.range(1, 12),
		[] as ReadonlyArray<unknown>,
		(child) => [group(child), group(child)],
	)
	assert(Result.isSuccess(Tree.validateStructure(input)))
	assert.strictEqual(reads, 24)
	assert(Result.isFailure(Tree.validate(input)))
})
