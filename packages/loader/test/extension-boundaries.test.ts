import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Option,
	Queue,
	Ref,
	Schema,
	Stream,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Entry, Intercept, Loader, Tree } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

const logged = (message: string) =>
	Graft.logs.pipe(
		Stream.filter(
			(entry) =>
				Array.isArray(entry.message) && Array.contains(entry.message, message),
		),
		Stream.runHead,
		Effect.map(Option.getOrThrow),
	)

it.effect.each(["throw", "die"])(
	"settles a Store.apply %s and continues processing edits",
	(mode) =>
		run()(() =>
			Effect.gen(function* () {
				const current = yield* Ref.make<ReadonlyArray<Entry.Entry>>([])
				const defect = new Error("Store apply crashed")
				const owner = yield* Graft.plugin(
					Plugin.make({
						name: "stored",
						apply: () =>
							Loader.start({
								initial: [],
								apply: (op) => {
									if (op._tag === "Create" && op.entry.id === "broken") {
										if (mode === "throw") throw defect
										return Effect.die(defect)
									}
									return Ref.get(current).pipe(
										Effect.flatMap((entries) =>
											Effect.fromResult(Tree.apply(entries, op)),
										),
										Effect.tap((entries) => Ref.set(current, entries)),
									)
								},
								refresh: Effect.succeedNone,
								external: Stream.never,
							}),
					}),
				)
				yield* owner.await
				const loader = yield* loaderService
				const exit = yield* Effect.exit(
					loader.create({ id: "broken", name: "unused", disabled: true }),
				)
				assert(Exit.isFailure(exit))
				assert.strictEqual(exit.cause.reasons.length, 1)
				assert.isTrue(Cause.hasDies(exit.cause))
				assert.strictEqual(Cause.squash(exit.cause), defect)
				const record = yield* logged("Applying a loader edit failed")
				assert.strictEqual(Cause.squash(record.cause), defect)
				yield* loader.create({ id: "healthy", name: "unused", disabled: true })
				const entries = yield* loader.entries
				assert.deepStrictEqual(
					Array.map(entries, (entry) => entry.id),
					["healthy"],
				)
				yield* owner.dispose
			}),
		),
)

it.effect(
	"settles an already dequeued request when closing after a synchronous throw",
	() =>
		run()(() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const replied =
					yield* Deferred.make<Exit.Exit<unknown, Loader.EditError>>()
				const defect = new Error("Store apply crashed")
				const owner = yield* Graft.plugin(
					Plugin.make({
						name: "stored",
						apply: () =>
							Loader.start({
								initial: [],
								apply: () => {
									Deferred.doneUnsafe(entered, Effect.void)
									throw defect
								},
								refresh: Effect.succeedNone,
								external: Stream.never,
							}),
					}),
				)
				const loader = yield* loaderService
				yield* loader
					.create({ id: "broken", name: "unused", disabled: true })
					.pipe(
						Effect.onExit((exit) => Deferred.succeed(replied, exit)),
						Effect.forkScoped,
					)
				yield* Deferred.await(entered)
				yield* owner.dispose
				const exit = yield* Deferred.await(replied)
				assert(Exit.isFailure(exit))
				assert.isTrue(Cause.hasDies(exit.cause))
			}),
		),
)

it.effect(
	"reads a throwing refresh getter inside the per-notification boundary",
	() =>
		run()(() =>
			Effect.gen(function* () {
				const queue = yield* Queue.unbounded<void>()
				const broken = yield* Ref.make(true)
				const defect = new Error("Refresh construction crashed")
				const store: Loader.Store = {
					initial: [],
					apply: () => Effect.succeed([]),
					external: Stream.fromQueue(queue),
					get refresh() {
						if (Ref.getUnsafe(broken)) throw defect
						return Effect.succeedSome([
							{ id: "external", name: "unused", disabled: true },
						])
					},
				}
				yield* Graft.plugin(
					Plugin.make({ name: "stored", apply: () => Loader.start(store) }),
				)
				const loader = yield* loaderService
				yield* Queue.offer(queue, undefined)
				const record = yield* logged("Refreshing loader entries failed")
				assert.strictEqual(Cause.squash(record.cause), defect)
				yield* Ref.set(broken, false)
				yield* Queue.offer(queue, undefined)
				const entries = yield* loader.changes.pipe(
					Stream.filter((entries) => entries.length === 1),
					Stream.runHead,
				)
				assert.strictEqual(Option.getOrThrow(entries)[0]?.id, "external")
			}),
		),
)

it.effect("logs a throwing external getter without disabling API edits", () =>
	run()(() =>
		Effect.gen(function* () {
			const defect = new Error("Notification construction crashed")
			const store: Loader.Store = {
				initial: [],
				apply: () => Effect.succeed([]),
				refresh: Effect.succeedNone,
				get external(): Stream.Stream<void> {
					throw defect
				},
			}
			yield* Graft.plugin(
				Plugin.make({ name: "stored", apply: () => Loader.start(store) }),
			)
			const loader = yield* loaderService
			const record = yield* logged("Loader change notifications stopped")
			assert.strictEqual(Cause.squash(record.cause), defect)
			yield* loader.create({ id: "accepted", name: "unused", disabled: true })
		}),
	),
)

const Settings = Context.Reference(
	"loader/test/extension-boundaries/Settings",
	{ defaultValue: () => "default" },
)
it.effect.each(["merge", "registration"])(
	"isolates a synchronous %s callback defect and permits retry",
	(stage) =>
		Effect.gen(function* () {
			const defect = new Error("Extension callback crashed")
			const broken = yield* Ref.make(true)
			const registration = Intercept.make(
				Settings,
				Schema.String,
				(_outer, patch) => {
					if (stage === "merge" && Ref.getUnsafe(broken)) throw defect
					return patch
				},
			)
			const environment = Intercept.layer([
				{
					key: Settings.key,
					schema: Schema.Unknown,
					resolve: (input) => {
						if (stage === "registration" && Ref.getUnsafe(broken)) throw defect
						return registration.resolve(input)
					},
				},
			])
			yield* run()((journal) =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [
						{
							id: "extension",
							name: "echo",
							config: { text: "started" },
							intercept: { [Settings.key]: "patched" },
						},
					])
					const loader = yield* loaderService
					yield* loader.ready
					const record = yield* Graft.logs.pipe(
						Stream.filter((entry) => Cause.hasDies(entry.cause)),
						Stream.runHead,
					)
					assert.strictEqual(
						Cause.squash(Option.getOrThrow(record).cause),
						defect,
					)
					yield* Ref.set(broken, false)
					yield* loader.retry
					yield* loader.ready
					yield* journal.expect(["start started"])
				}),
			).pipe(Effect.provide(environment))
		}),
)
