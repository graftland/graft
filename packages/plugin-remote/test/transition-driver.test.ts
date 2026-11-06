import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Path,
	Ref,
	Sink,
	Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin, Transition } from "@graftland/graft"

import { ProcessExited, TransportError } from "../src/Errors"
import * as Remote from "../src/index"
import {
	LocalTransport,
	WorkerTransport,
} from "../src/internal/directTransport"
import { driver } from "../src/internal/transition"
import { contract } from "./fixtures/transition-contract"

it.effect(
	"reports Stuck for lost transport and termination acknowledgement without an exit event",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const root = yield* fs.makeTempDirectoryScoped({
				directory: new URL("../.cache", import.meta.url).pathname,
				prefix: "transition-driver-",
			})
			const source = root + "/source"
			yield* fs.makeDirectory(source)
			yield* fs.writeFileString(source + "/package.json", '{"type":"module"}')
			yield* fs.writeFileString(
				source + "/plugin.js",
				"export default undefined",
			)
			const artifact = yield* Remote.Artifact.capture({
				directory: source,
				entry: "plugin.js",
				store: root + "/store",
			})
			const candidate = Remote.candidate({
				artifact,
				contractModule: "unused-contract",
				target: { _tag: "Worker" },
				input: { value: "new" },
			})
			const lost = yield* Deferred.make<void>()
			const terminated = yield* Deferred.make<void>()
			const exited = yield* Deferred.make<ProcessExited>()
			const previousExited = yield* Deferred.make<Transition.Termination>()
			const count = yield* Ref.make(0)
			const status = ProcessExited.make({
				pid: Option.none(),
				exitCode: 0,
				stderr: "",
				statusCause: Cause.empty,
			})
			const transport = {
				start: (_: unknown, onSpawn?: Effect.Effect<void>) =>
					Effect.gen(function* () {
						yield* onSpawn ?? Effect.void
						yield* Ref.update(count, (n) => n + 1)
						return {
							pid: Option.none(),
							channel: {
								input: Stream.fromEffect(Deferred.await(lost)).pipe(
									Stream.flatMap(() =>
										Stream.fail(
											TransportError.make({
												cause: Cause.fail("Transport lost without exit"),
											}),
										),
									),
								),
								output: Sink.drain,
							},
							failure: Effect.never,
							exited: Deferred.await(exited),
							terminate: Deferred.succeed(terminated, undefined).pipe(
								Effect.as(status),
							),
						}
					}),
			}
			const initial: Transition.Unit = {
				start: Effect.void,
				describe: Effect.succeed({ overlap: true, provides: [] }),
				serve: Effect.void,
				ready: Effect.succeed(Context.empty()),
				probe: () => Effect.void,
				stop: Effect.void,
				terminate: Deferred.succeed(previousExited, {
					unit: "initial",
					state: "Exited",
				}).pipe(Effect.asVoid),
				exited: Deferred.await(previousExited),
				failure: Effect.never,
			}
			const managed = yield* Graft.plugin(
				Plugin.make({
					name: "controlled-remote-driver",
					inject: [FileSystem.FileSystem, Path.Path, SecureRandom.SecureRandom],
					apply: () =>
						Effect.gen(function* () {
							const remote = yield* driver(contract).pipe(
								Effect.provideService(WorkerTransport, transport),
								Effect.provideService(LocalTransport, {
									start: () => Effect.die("Unexpected child launch"),
								}),
							)
							yield* Transition.registerDriver(
								{
									name: remote.name,
									allocate: (candidate, attempt) =>
										attempt === 1
											? Effect.succeed(initial)
											: remote.allocate(candidate, attempt),
								},
								{
									instance: "integration",
									initial: candidate,
									required: [],
									facades: [],
									policy: {
										total: 10_000,
										startup: 100,
										probe: 100,
										drain: 100,
										stop: 100,
										terminate: 100,
									},
								},
							)
						}),
				}),
			)
			yield* managed.await
			const request = Graft.transition({ target: managed.id, candidate })
			const running = yield* Effect.forkScoped(request)
			// Wait for allocation (including artifact verification) before advancing virtual time.
			yield* managed.generations.pipe(
				Stream.filter((all) => Array.some(all, (item) => item.attempt === 2)),
				Stream.runHead,
			)
			yield* Deferred.succeed(lost, undefined)
			yield* Deferred.await(terminated)
			yield* TestClock.adjust(100)
			const result = yield* Fiber.join(running)
			assert.equal(result._tag, "Stuck")
			assert.isFalse(
				Array.some(
					result.evidence,
					(item) => item.attempt === 2 && item.termination !== undefined,
				),
			)
			const starts = yield* Ref.get(count)
			assert.equal(starts, 1)
			yield* Deferred.succeed(exited, status)
			const later = yield* request
			assert.deepEqual(
				later,
				Transition.Outcome.Aborted({
					phase: "Admission",
					reason: "Stuck",
					evidence: [],
				}),
			)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Graft.layer.pipe(
					Layer.provideMerge(
						Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
					),
				),
			),
		),
)

it.effect(
	"terminating an allocated unit confirms NotStarted and prevents later startup",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const root = yield* fs.makeTempDirectoryScoped()
			yield* fs.writeFileString(root + "/package.json", '{"type":"module"}')
			yield* fs.writeFileString(root + "/plugin.js", "export default undefined")
			const store = yield* fs.makeTempDirectoryScoped()
			const artifact = yield* Remote.Artifact.capture({
				directory: root,
				entry: "plugin.js",
				store,
			})
			const launches = yield* Ref.make(0)
			const start = () =>
				Ref.update(launches, (n) => n + 1).pipe(Effect.andThen(Effect.never))
			const remote = yield* driver(contract).pipe(
				Effect.provideService(WorkerTransport, { start }),
				Effect.provideService(LocalTransport, { start }),
			)
			const unit = yield* remote.allocate(
				Remote.candidate({
					artifact,
					contractModule: "unused",
					target: { _tag: "Worker" },
					input: { value: "old" },
				}),
				1,
			)
			const pending = yield* Effect.forkScoped(
				unit.terminate.pipe(
					Effect.andThen(unit.exited),
					Effect.timeoutOption(10),
				),
			)
			yield* TestClock.adjust(10)
			const observed = yield* Fiber.join(pending)
			assert.isTrue(Option.isSome(observed))
			if (Option.isSome(observed))
				assert.equal(observed.value.state, "NotStarted")
			const started = yield* Effect.result(unit.start)
			assert.equal(started._tag, "Failure")
			const count = yield* Ref.get(launches)
			assert.equal(count, 0)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
			),
		),
)

for (const placement of ["Worker", "Local"] as const) {
	it.effect(
		`termination racing ${placement} startup waits for execution evidence`,
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const root = yield* fs.makeTempDirectoryScoped()
				yield* fs.writeFileString(root + "/package.json", '{"type":"module"}')
				yield* fs.writeFileString(
					root + "/plugin.js",
					"export default undefined",
				)
				const store = yield* fs.makeTempDirectoryScoped()
				const artifact = yield* Remote.Artifact.capture({
					directory: root,
					entry: "plugin.js",
					store,
				})
				const spawned = yield* Deferred.make<void>()
				const publish = yield* Deferred.make<void>()
				const exited = yield* Deferred.make<ProcessExited>()
				const status = ProcessExited.make({
					pid: Option.none(),
					exitCode: 0,
					stderr: "",
					statusCause: Cause.empty,
				})
				const transport = {
					start: (_: unknown, onSpawn?: Effect.Effect<void>) =>
						Effect.gen(function* () {
							yield* onSpawn ?? Effect.void
							yield* Deferred.succeed(spawned, undefined)
							yield* Deferred.await(publish)
							return {
								pid: Option.none(),
								channel: { input: Stream.never, output: Sink.drain },
								failure: Effect.never,
								exited: Deferred.await(exited),
								terminate: Deferred.succeed(exited, status).pipe(
									Effect.as(status),
								),
							}
						}),
				}
				const remote = yield* driver(contract).pipe(
					Effect.provideService(WorkerTransport, transport),
					Effect.provideService(LocalTransport, transport),
				)
				const unit = yield* remote.allocate(
					Remote.candidate({
						artifact,
						contractModule: "unused",
						target: { _tag: placement },
						input: { value: "old" },
					}),
					1,
				)
				const starting = yield* Effect.forkScoped(Effect.exit(unit.start))
				yield* Deferred.await(spawned)
				const terminating = yield* Effect.forkScoped(
					unit.terminate.pipe(Effect.andThen(unit.exited)),
				)
				yield* TestClock.adjust(10)
				assert.isUndefined(terminating.pollUnsafe())
				yield* Deferred.succeed(publish, undefined)
				const evidence = yield* Fiber.join(terminating)
				assert.equal(evidence.state, "Exited")
				yield* Fiber.interrupt(starting)
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
				),
			),
	)
}
