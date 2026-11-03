import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import process from "node:process"
import * as Remote from "../src/index"
import {
	ChildApi,
	ChildLabel,
	HostApi,
	contract,
} from "./fixtures/services-contract"
const contractModule = new URL(
	"../.cache/integration/services-contract.js",
	import.meta.url,
).href
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
	)
const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	const provider = yield* Graft.plugin(
		Plugin.make({
			name: "host-provider",
			apply: () =>
				Graft.provide(HostApi, { double: (n) => Effect.succeed(n * 2) }),
		}),
	)
	yield* provider.await
	const proxy = yield* Graft.plugin(
		Remote.plugin(contract, { contractModule }),
		{ directory, fail: false },
	)
	yield* proxy.await
	const service = yield* Deferred.make<ChildApi["Service"]>()
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "host-consumer",
			inject: [ChildApi],
			apply: () =>
				Effect.gen(function* () {
					const api = yield* ChildApi
					yield* Deferred.succeed(service, api)
				}),
		}),
	)
	yield* consumer.await
	const api = yield* Deferred.await(service)
	return { fs, directory, provider, proxy, consumer, api }
})
const waitFile = (file: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.exists(file).pipe(
			Effect.repeat({
				schedule: Schedule.spaced("10 millis"),
				until: (exists) => exists,
			}),
			Effect.timeout("3 seconds"),
		)
	})
describe("cross-process services", () => {
	it.live(
		"routes equal service tags independently from the control endpoint",
		() =>
			Effect.gen(function* () {
				const { api } = yield* setup
				const label = yield* Deferred.make<string>()
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "label-consumer",
						inject: [ChildLabel],
						apply: () =>
							Effect.gen(function* () {
								const service = yield* ChildLabel
								const value = yield* service.read
								yield* Deferred.succeed(label, value)
							}),
					}),
				)
				yield* consumer.await
				const value = yield* Deferred.await(label)
				assert.equal(value, "independent endpoint")
				const reply = yield* api.call(20)
				assert.equal(reply.value, 41)
			}).pipe(run),
	)

	it.live(
		"calls the host through the child service and exposes the local instance identity",
		() =>
			Effect.gen(function* () {
				const { proxy, api } = yield* setup
				const result = yield* api.call(20)
				assert.equal(result.value, 41)
				assert.notEqual(result.pid, process.pid)
				assert.match(
					result.id,
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				)
				assert.equal(result.generation, 1)
				yield* proxy.dispose
				assert.throws(() => process.kill(result.pid, 0))
			}).pipe(run),
	)
	it.live(
		"keeps the child and reverse service alive while a host consumer finalizes",
		() =>
			Effect.gen(function* () {
				const { fs, directory, proxy, api } = yield* setup
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const result = yield* Ref.make(0)
				const finalizer = yield* Graft.plugin(
					Plugin.make({
						name: "finalizing-consumer",
						inject: [ChildApi],
						apply: () =>
							Effect.gen(function* () {
								const child = yield* ChildApi
								yield* Effect.addFinalizer(() =>
									Effect.gen(function* () {
										const reply = yield* child.call(41)
										const finalized = yield* fs
											.exists(`${directory}/finalized-${reply.pid}`)
											.pipe(Effect.orDie)
										assert.isFalse(finalized)
										yield* Ref.set(result, reply.value)
										yield* Deferred.succeed(entered, undefined)
										yield* Deferred.await(release)
									}),
								)
							}),
					}),
				)
				yield* finalizer.await
				const pid = (yield* api.call(0)).pid
				const disposing = yield* Effect.forkScoped(proxy.dispose)
				yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"))
				assert.equal(disposing.pollUnsafe(), undefined)
				assert.doesNotThrow(() => process.kill(pid, 0))
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(disposing)
				const value = yield* Ref.get(result)
				assert.equal(value, 83)
				yield* waitFile(`${directory}/finalized-${pid}`)
				assert.throws(() => process.kill(pid, 0))
			}).pipe(run),
	)
	it.live(
		"withdraws a host dependency and restarts the proxy in a fresh process",
		() =>
			Effect.gen(function* () {
				const { provider, proxy, api } = yield* setup
				const before = yield* api.call(1)
				yield* provider.dispose
				assert.throws(() => process.kill(before.pid, 0))
				const replacement = yield* Graft.plugin(
					Plugin.make({
						name: "replacement",
						apply: () =>
							Graft.provide(HostApi, { double: (n) => Effect.succeed(n * 3) }),
					}),
				)
				yield* replacement.await
				yield* proxy.await
				const service = yield* Deferred.make<ChildApi["Service"]>()
				const consumer = yield* Graft.plugin(
					Plugin.make({
						name: "new-consumer",
						inject: [ChildApi],
						apply: () =>
							Effect.gen(function* () {
								const api = yield* ChildApi
								yield* Deferred.succeed(service, api)
							}),
					}),
				)
				yield* consumer.await
				const current = yield* Deferred.await(service)
				const after = yield* current.call(2)
				assert.equal(after.value, 7)
				assert.notEqual(after.pid, before.pid)
				assert.notEqual(after.id, before.id)
			}).pipe(run),
	)
	it.live("detects a publication cycle through the proxy on the host", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const provider = yield* Graft.plugin(
				Plugin.make({
					name: "cyclic-provider",
					inject: [Plugin.optional(ChildApi)],
					apply: () =>
						Graft.provide(HostApi, { double: (n) => Effect.succeed(n) }),
				}),
			)
			yield* provider.await
			const proxy = yield* Graft.plugin(
				Remote.plugin(contract, { contractModule }),
				{ directory, fail: false },
			)
			const exit = yield* Effect.exit(proxy.await)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.isTrue(
					Array.some(
						exit.cause.reasons,
						(reason) =>
							reason._tag === "Fail" &&
							Schema.is(Graft.ServiceConflict)(reason.error) &&
							reason.error.reason === "DependencyCycle",
					),
				)
		}).pipe(run),
	)
	it.live("streams and interrupts requests across the process boundary", () =>
		Effect.gen(function* () {
			const { directory, api } = yield* setup
			const values = yield* api.values.pipe(Stream.take(3), Stream.runCollect)
			assert.deepEqual(values, [0, 1, 2])
			yield* waitFile(`${directory}/stream-ended`)
			const held = yield* Effect.forkScoped(api.hold)
			yield* waitFile(`${directory}/holding`)
			yield* Fiber.interrupt(held)
			yield* waitFile(`${directory}/hold-ended`)
		}).pipe(run),
	)
	it.live(
		"keeps the host loading until an active child publishes every declared export",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				yield* fs.writeFileString(`${directory}/delay-export`, "delay")
				const provider = yield* Graft.plugin(
					Plugin.make({
						name: "host-provider",
						apply: () =>
							Graft.provide(HostApi, { double: (n) => Effect.succeed(n * 2) }),
					}),
				)
				yield* provider.await
				const proxy = yield* Graft.plugin(
					Remote.plugin(contract, { contractModule }),
					{ directory, fail: false },
				)
				const active = yield* Effect.forkScoped(proxy.await)
				yield* waitFile(`${directory}/awaiting-export`)
				yield* Effect.sleep("100 millis")
				assert.equal(active.pollUnsafe(), undefined)
				yield* fs.writeFileString(`${directory}/release-export`, "release")
				yield* Fiber.join(active).pipe(Effect.timeout("3 seconds"))
				const state = yield* Stream.runHead(proxy.state)
				assert.isTrue(Option.isSome(state) && state.value._tag === "Active")
			}).pipe(run),
	)

	it.live(
		"retains apply failure after publishing without waiting forever for an export lease",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				yield* fs.writeFileString(`${directory}/fail-apply`, "fail")
				const provider = yield* Graft.plugin(
					Plugin.make({
						name: "host-provider",
						apply: () =>
							Graft.provide(HostApi, { double: (n) => Effect.succeed(n * 2) }),
					}),
				)
				yield* provider.await
				const proxy = yield* Graft.plugin(
					Remote.plugin(contract, { contractModule }),
					{ directory, fail: false },
				)
				const exit = yield* Effect.exit(
					proxy.await.pipe(Effect.timeout("3 seconds")),
				)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.isTrue(
						Array.some(
							exit.cause.reasons,
							(reason) =>
								(reason._tag === "Fail" &&
									reason.error === "Remote apply failed") ||
								(reason._tag === "Die" &&
									reason.defect === "Remote apply failed"),
						),
					)
				const pidText = yield* fs.readFileString(`${directory}/pid`)
				assert.throws(() => process.kill(Number(pidText), 0))
			}).pipe(run),
	)

	it.live(
		"drains exported services when the remote worker fails without a lease deadlock",
		() =>
			Effect.gen(function* () {
				const { directory, fs, proxy } = yield* setup
				yield* proxy.update({ directory, fail: true })
				yield* proxy.await
				yield* fs.writeFileString(`${directory}/fail`, "fail")
				const state = yield* proxy.state.pipe(
					Stream.filter((state) => state._tag === "Failed"),
					Stream.runHead,
					Effect.timeout("5 seconds"),
				)
				assert.isTrue(Option.isSome(state))
				if (Option.isSome(state) && state.value._tag === "Failed") {
					assert.isTrue(
						Array.some(
							state.value.cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(Remote.RemoteWithdrawn)(reason.error),
						),
					)
					assert.isFalse(
						Array.some(
							state.value.cause.reasons,
							(reason) =>
								reason._tag === "Die" &&
								reason.defect instanceof Error &&
								reason.defect.message === "Remote service is withdrawing",
						),
					)
					assert.isTrue(
						Array.some(
							state.value.cause.reasons,
							(reason) =>
								(reason._tag === "Fail" &&
									reason.error === "Remote worker failed") ||
								(reason._tag === "Die" &&
									reason.defect === "Remote worker failed"),
						),
					)
				}
				const pidText = yield* fs.readFileString(`${directory}/pid`)
				const pid = Number(pidText)
				assert.throws(() => process.kill(pid, 0))
			}).pipe(run),
	)
})
