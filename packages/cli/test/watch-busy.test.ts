import { createServer, type Socket } from "node:net"

import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	HashMap,
	HashSet,
	Layer,
	Option,
	Ref,
	Schema,
	Stream,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
const budget = {
	total: 90000,
	startup: 20000,
	drain: 1000,
	stop: 1000,
	terminate: 1000,
	probe: 1000,
}

it.live(
	"applies the latest saved input after a real conflicting Change concludes without polling admission",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const root = new URL("../.cache/watch-busy-tests/", import.meta.url)
				.pathname
			yield* fs.makeDirectory(root, { recursive: true })
			const directory = yield* fs.makeTempDirectoryScoped({ directory: root })
			const plugin = yield* quote(
				new URL("../.cache/integration/plugin.mjs", import.meta.url).href,
			)
			const effect = yield* quote(import.meta.resolve("effect"))
			yield* fs.writeFileString(
				`${directory}/package.json`,
				'{"name":"busy-watch-fixture","type":"module"}',
			)
			yield* fs.writeFileString(
				`${directory}/app.mjs`,
				`import {createConnection} from "node:net";import {Plugin} from ${plugin};import {Effect,Schema} from ${effect};export default Plugin.make({name:"app",config:Schema.Struct({version:Schema.Number,gate:Schema.optionalKey(Schema.Number)}),apply:c=>Effect.gen(function*(){if(c.gate!==undefined)yield* Effect.callback(resume=>{const socket=createConnection({host:"127.0.0.1",port:c.gate});socket.once("data",()=>resume(Effect.void));socket.once("error",cause=>resume(Effect.die(cause)));return Effect.sync(()=>socket.destroy())});})});`,
			)
			const save = (version: number) =>
				fs.writeFileString(
					`${directory}/graft.yml`,
					`- id: app\n  name: ./app.mjs\n  config:\n    version: ${version}\n`,
				)
			yield* save(1)
			const held = yield* Deferred.make<Socket>()
			const server = yield* Effect.acquireRelease(
				Effect.sync(() =>
					createServer((socket) =>
						Deferred.doneUnsafe(held, Exit.succeed(socket)),
					),
				),
				(server) =>
					Effect.sync(() => {
						server.close()
					}),
			)
			const gate = yield* Effect.callback<number>((resume) => {
				server.once("error", (cause) => resume(Effect.die(cause)))
				server.listen({ host: "127.0.0.1", port: 0 }, () => {
					const address = server.address()
					resume(
						address !== null && typeof address !== "string"
							? Effect.succeed(address.port)
							: Effect.die("No startup gate address"),
					)
				})
			})
			const store = `${directory}/.graft/artifacts`
			const app = yield* Artifact.capture({
				directory,
				module: "app.mjs",
				store,
				exclude: ["graft.yml", ".graft"],
			})
			const loader = yield* Artifact.capture({
				directory: new URL("../../loader/", import.meta.url).pathname,
				module: "dist/Deployment.js",
				store,
				exclude: ["node_modules", ".cache", "src", "test"],
			})
			yield* Effect.gen(function* () {
				const kernel = yield* Kernel.Kernel
				const submissions = yield* Ref.make<ReadonlyArray<Kernel.Request>>([])
				const admitted = yield* Ref.make(HashSet.empty<string>())
				const rejected = yield* Deferred.make<void>()
				const rejectedAgain = yield* Deferred.make<void>()
				const address = yield* Control.serve().pipe(
					Effect.provideService(
						Kernel.Kernel,
						Kernel.Kernel.of({
							...kernel,
							submit: (request) =>
								Ref.update(submissions, Array.append(request)).pipe(
									Effect.andThen(kernel.submit(request)),
									Effect.tap((handle) =>
										Ref.update(admitted, HashSet.add(handle.id)),
									),
									Effect.tapError((error) =>
										error.reason === "Busy"
											? Deferred.isDone(rejected).pipe(
													Effect.flatMap((done) =>
														Deferred.succeed(
															done ? rejectedAgain : rejected,
															undefined,
														),
													),
												)
											: Effect.void,
									),
								),
						}),
					),
				)
				const first = yield* kernel.submit({
					operations: [
						{
							_tag: "Deploy",
							instance: "loader",
							target: Units.target({
								artifact: loader,
								placement: "Worker",
								input: {
									config: `${directory}/graft.yml`,
									control: address,
									watch: true,
								},
							}),
						},
					],
					budget,
				})
				const initial = yield* first.await
				assert.equal(initial.outcome, "Accepted", Cause.pretty(initial.cause))
				const initiallyAdmitted = yield* Ref.get(admitted)
				const initialIds = HashSet.add(initiallyAdmitted, first.id)
				const conflict = yield* kernel.submit({
					operations: [
						{
							_tag: "Deploy",
							instance: "app",
							target: Units.target({
								artifact: app,
								placement: "Worker",
								input: { version: 2, gate },
							}),
						},
					],
					budget,
				})
				const socket = yield* Deferred.await(held)
				const applied = yield* Deferred.make<void>()
				yield* kernel.changes.pipe(
					Stream.runForEach((status) =>
						!HashSet.has(initialIds, status.id) &&
						status.id !== conflict.id &&
						Option.exists(status.conclusion, (c) => c.outcome === "Accepted") &&
						Option.exists(
							HashMap.get(status.plan.desired, "app"),
							(member) =>
								member.target.deployment?.input !== null &&
								typeof member.target.deployment?.input === "object" &&
								"version" in member.target.deployment.input &&
								member.target.deployment.input["version"] === 1,
						)
							? Deferred.succeed(applied, undefined)
							: Effect.void,
					),
					Effect.forkScoped({ startImmediately: true }),
				)
				yield* save(3)
				yield* Deferred.await(rejected)
				yield* Effect.sleep("750 millis")
				const waiting = yield* Ref.get(submissions)
				assert.lengthOf(
					waiting,
					2,
					"The rejected edit must not be resubmitted before the conflict concludes",
				)
				// Restoring the original input must still replace the target the other Change installs.
				yield* save(1)
				yield* Deferred.await(rejectedAgain)
				yield* Effect.sleep("750 millis")
				const newest = yield* Ref.get(submissions)
				assert.lengthOf(
					newest,
					3,
					"A new save replans once and then waits again",
				)
				yield* Effect.sync(() => socket.end("release"))
				const conclusion = yield* conflict.await
				assert.equal(
					conclusion.outcome,
					"Accepted",
					Cause.pretty(conclusion.cause),
				)
				yield* Deferred.await(applied).pipe(Effect.timeout("10 seconds"))
				const after = yield* Ref.get(submissions)
				assert.lengthOf(after, 4)
			}).pipe(
				Effect.provide(
					Kernel.layer({
						authority: "busy-watch",
						maxUnits: 16,
						instances: [],
					}).pipe(Layer.provide(Units.layer)),
				),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)
