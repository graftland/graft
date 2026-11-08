import { Array, Cause, Context, Effect, Option, Ref, Stream } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, type Fork } from "@graftland/graft"

import { Loader } from "../src/index.ts"
import { fixture, loaderService, run } from "./utils.ts"

const flatten = (
	nodes: ReadonlyArray<Fork.ForkTree>,
): ReadonlyArray<Fork.ForkTree> =>
	Array.flatMap(nodes, (node) => [node, ...flatten(node.children)])
const cleanupLog = Graft.logs.pipe(
	Stream.filter(
		(entry) =>
			Array.isArray(entry.message) &&
			Array.contains(entry.message, "Disposing a loader entry failed"),
	),
	Stream.runHead,
	Effect.map(Option.getOrThrow),
)
const defects = (cause: Cause.Cause<unknown>): ReadonlyArray<unknown> =>
	Array.flatMap(cause.reasons, (reason): ReadonlyArray<unknown> => {
		const value = Cause.isDieReason(reason)
			? reason.defect
			: Cause.isFailReason(reason)
				? reason.error
				: undefined
		if (
			typeof value === "object" &&
			value !== null &&
			"cause" in value &&
			Cause.isCause(value.cause)
		)
			return defects(value.cause)
		return Cause.isDieReason(reason) ? [value] : []
	})

it.effect.each(["remove", "disable", "replace"])(
	"continues reconciliation after cleanup fails during %s",
	(operation) =>
		Effect.gen(function* () {
			const first = new Error("First cleanup failed")
			const second = new Error("Second cleanup failed")
			yield* run({
				broken: fixture("group-cleanup-broken-1435"),
				healthy: fixture("group-cleanup-healthy-1435"),
				replacement: fixture("group-cleanup-replacement-1435"),
			})((journal) =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{ id: "broken", name: "broken" },
						{ id: "healthy", name: "healthy" },
					])
					const loader = yield* loaderService
					yield* loader.ready
					if (operation === "remove") yield* loader.remove("broken")
					else if (operation === "disable")
						yield* loader.update("broken", { disabled: true })
					else yield* loader.update("broken", { name: "replacement" })
					yield* loader.ready
					const log = yield* cleanupLog
					assert.sameMembers([...defects(log.cause)], [first, second])
					assert.strictEqual(log.annotations["loader.entry"], "broken")
					assert.strictEqual(log.annotations["loader.plugin"], "broken")
					assert.isNumber(log.annotations["graft.fork"])
					const root = yield* Stream.runHead(loader.root.state)
					assert.strictEqual(Option.getOrThrow(root)._tag, "Active")
					const trees = yield* Stream.runHead(Graft.forks)
					assert.isFalse(
						Array.some(
							flatten(Option.getOrThrow(trees)),
							(node) => node.name === "broken",
						),
					)
					yield* journal.expect(
						operation === "replace"
							? [["start broken", "start healthy"], "start replacement"]
							: [["start broken", "start healthy"]],
					)
					yield* loader.create({ id: "later", name: "healthy" })
					yield* loader.ready
					yield* journal.expect(
						operation === "replace"
							? [
									["start broken", "start healthy"],
									"start replacement",
									"start healthy",
								]
							: [["start broken", "start healthy"], "start healthy"],
					)
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{
						readonly first: typeof first
						readonly second: typeof second
					}>("loader/fixture/group-cleanup-broken-1435"),
					{ first, second },
				),
			)
		}),
)

it.effect(
	"retains restart cleanup failure on the actual plugin and retries its latest input",
	() =>
		Effect.gen(function* () {
			const broken = yield* Ref.make(true)
			const cleanup = new Error("Restart cleanup failed")

			yield* run({ changing: fixture("group-cleanup-changing-4156") })(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{ id: "entry", name: "changing", config: "before" },
					])
					const loader = yield* loaderService
					yield* loader.ready
					yield* loader.update("entry", { config: "after" })
					yield* loader.ready
					const trees = yield* Stream.runHead(Graft.forks)
					const failed = Array.findFirst(
						flatten(Option.getOrThrow(trees)),
						(node) => node.state._tag === "Failed",
					)
					assert(Option.isSome(failed))
					assert(failed.value.state._tag === "Failed")
					assert.include(defects(failed.value.state.cause), cleanup)
					yield* Ref.set(broken, false)
					yield* loader.retry
					yield* loader.ready
					const recovered = yield* Stream.runHead(Graft.forks)
					const changing = Array.filter(
						flatten(Option.getOrThrow(recovered)),
						(node) => node.name === "changing",
					)
					assert.isTrue(
						Array.every(changing, (node) => node.state._tag === "Active"),
					)
					assert.isTrue(Array.some(changing, (node) => node.input === "after"))
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{
						readonly broken: typeof broken
						readonly cleanup: typeof cleanup
					}>("loader/fixture/group-cleanup-changing-4156"),
					{ broken, cleanup },
				),
			)
		}),
)

it.effect(
	"retains every cleanup cause when multiple entries are removed together",
	() =>
		Effect.gen(function* () {
			const first = new Error("First entry cleanup failed")
			const second = new Error("Second entry cleanup failed")

			yield* run({
				first: fixture("cleanup-per-entry"),
				second: fixture("cleanup-per-entry"),
			})(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{ id: "first", name: "first" },
						{ id: "second", name: "second" },
					])
					const loader = yield* loaderService
					yield* loader.ready
					yield* loader.root.update([])
					yield* loader.ready
					const logs = yield* Graft.logs.pipe(
						Stream.filter(
							(entry) =>
								Array.isArray(entry.message) &&
								Array.contains(
									entry.message,
									"Disposing a loader entry failed",
								),
						),
						Stream.take(2),
						Stream.runCollect,
					)
					assert.sameMembers(
						Array.flatMap(logs, (entry) => defects(entry.cause)),
						[first, second],
					)
				}),
			).pipe(
				Effect.provideService(
					Context.Service<{
						readonly first: typeof first
						readonly second: typeof second
					}>("loader/cleanup-per-entry"),
					{ first, second },
				),
			)
		}),
)
