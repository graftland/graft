import assert from "node:assert/strict"
import { test } from "node:test"

import {
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Option,
	Queue,
	Ref,
	Schedule,
	Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeServices } from "@effect/platform-node"

import { Change, Graft } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

import { contract, Forecast } from "@example/forecast-contract"

import { budget, requirements, start } from "../host/dist/app.js"

const runtime = Graft.layer.pipe(
	Layer.provideMerge(
		Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
	),
)
const directory = new URL("../", import.meta.url).pathname
const upgrade = (app, release) =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(app.operatorUrl + "/upgrade/" + release, {
				method: "POST",
			})
			assert.equal(response.status, 200)
			return response.json()
		},
		catch: (error) => error,
	})
const stable = (app) =>
	Effect.gen(function* () {
		assert.equal(app.session, "session-1")
		assert.equal(yield* Ref.get(app.upstream.session), app.session)
		const before = yield* Ref.get(app.upstream.heartbeats)
		yield* Ref.get(app.upstream.heartbeats).pipe(
			Effect.repeat({
				schedule: Schedule.spaced("10 millis"),
				until: (count) => count > before,
			}),
			Effect.timeout("2 seconds"),
		)
		assert.equal(yield* Ref.get(app.upstream.logins), 1)
		assert.equal(yield* Ref.get(app.gatewayActivations), 1)
		assert.equal(yield* Ref.get(app.consumerActivations), 1)
		assert.ok((yield* Ref.get(app.upstream.heartbeats)) > 0)
	})
const trial = (app) =>
	Effect.gen(function* () {
		const transition = yield* Effect.forkScoped(upgrade(app, "broken-trial"))
		yield* app.ask("trial", "London").pipe(
			Effect.repeat({
				schedule: Schedule.spaced("10 millis"),
				until: (reply) => reply.text.startsWith("v2"),
			}),
		)
		yield* app.ask("crash", "crash")
		return yield* Fiber.join(transition)
	})
for (const target of [{ _tag: "Worker", execArgv: [] }, { _tag: "Local" }]) {
	const run = (name, body) =>
		test(`${target._tag}: ${name}`, { timeout: 60_000 }, () =>
			Effect.runPromise(
				Effect.gen(function* () {
					const app = yield* start(directory, target)
					yield* body(app)
				}).pipe(Effect.scoped, Effect.provide(runtime)),
			),
		)
	run(
		"changes a second managed instance while the first is gated in a probe",
		(app) =>
			Effect.gen(function* () {
				const secondary = yield* Graft.plugin(
					Remote.plugin(contract, {
						instance: "secondary",
						artifact: app.artifactFor("v1"),
						contractModule: import.meta.resolve("@example/forecast-contract"),
						target,
						budget,
						requirements,
					}),
					app.input,
					{ isolate: [Forecast] },
				)
				yield* secondary.await
				const probing = yield* Change.changes.pipe(
					Stream.filter(
						(status) =>
							status.instance === "forecasts" && status.phase === "Probing",
					),
					Stream.runHead,
					Effect.forkScoped({ startImmediately: true }),
				)
				const a = yield* Change.submit({
					instance: "forecasts",
					candidate: Remote.candidate({
						...app.candidate("v2").deployment,
						input: { ...app.input, holdProbe: true },
					}),
					strategy: "Overlap",
					budget: { ...budget, total: "3 minutes", probe: "30 seconds" },
					requirements,
				})
				yield* Fiber.join(probing)
				const b = yield* Change.run({
					instance: "secondary",
					candidate: app.candidate("v2"),
					strategy: "Overlap",
					budget,
					requirements,
				})
				assert.equal(b._tag, "Accepted")
				assert.equal(b.members[0].actual.version, 2)
				const pending = yield* Change.get(a.id)
				assert.ok(Option.isNone(Option.getOrThrow(pending).outcome))
				yield* a.cancel
				assert.equal((yield* a.await)._tag, "Aborted")
				assert.equal(
					(yield* app.ask("parallel", "London")).text,
					"v1 forecast for London",
				)
				yield* stable(app)
			}),
	)
	run(
		"healthy upgrades preserve the session, activations and reclaim every old unit",
		(app) =>
			Effect.gen(function* () {
				assert.equal(
					(yield* app.ask("before", "London")).text,
					"v1 forecast for London",
				)
				const exited = new Set()
				for (const release of ["v2", "v1", "v2", "v1", "v2"]) {
					const outcome = yield* upgrade(app, release)
					assert.equal(outcome._tag, "Accepted")
					const terminations = outcome.evidence.flatMap((item) =>
						item.termination ? [item.termination] : [],
					)
					assert.equal(terminations.length, 1)
					assert.equal(terminations[0].state, "Exited")
					assert.ok(!exited.has(terminations[0].unit))
					exited.add(terminations[0].unit)
					assert.equal(
						(yield* app.ask(release, "London")).text,
						release + " forecast for London",
					)
				}
				assert.equal(exited.size, 5)
				yield* stable(app)
			}),
	)
	run("a failed probe aborts with its cause and v1 keeps serving", (app) =>
		Effect.gen(function* () {
			const outcome = yield* upgrade(app, "broken-probe")
			assert.equal(outcome._tag, "Aborted")
			assert.match(JSON.stringify(outcome.evidence), /Forecast probe failed/)
			assert.equal(
				(yield* app.ask("after", "London")).text,
				"v1 forecast for London",
			)
			yield* stable(app)
		}),
	)
	run(
		"trial failure recovers from the pinned artifact without reconnecting",
		(app) =>
			Effect.gen(function* () {
				assert.equal((yield* trial(app))._tag, "Recovered")
				assert.equal(
					(yield* app.ask("after", "London")).text,
					"v1 forecast for London",
				)
				yield* stable(app)
			}),
	)
	run("recovery failure preserves the upstream session", (app) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			yield* fs.writeFileString(
				app.artifactFor("v1").directory + "/tampered",
				"corrupt",
			)
			const outcome = yield* trial(app)
			assert.equal(outcome._tag, "RecoveryFailed")
			assert.match(JSON.stringify(outcome.evidence), /Artifact digest mismatch/)
			yield* stable(app)
		}),
	)
	run("a slow admitted request stays on v1 across cutover", (app) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			yield* app.upstream.message("slow", "slow")
			yield* fs.exists(app.input.started).pipe(
				Effect.repeat({
					schedule: Schedule.spaced("10 millis"),
					until: (exists) => exists,
				}),
			)
			const transition = yield* Effect.forkScoped(upgrade(app, "v2"))
			yield* app.ask("new", "London").pipe(
				Effect.repeat({
					schedule: Schedule.spaced("10 millis"),
					until: (reply) => reply.text.startsWith("v2"),
				}),
			)
			yield* fs.writeFileString(app.input.release, "release")
			const old = yield* Queue.take(app.upstream.responses)
			assert.deepEqual(old, {
				kind: "response",
				id: "slow",
				text: "v1 forecast for slow",
			})
			assert.equal((yield* Fiber.join(transition))._tag, "Accepted")
			yield* stable(app)
		}),
	)
	run(
		"Loader rejects a managed edit before changing the file or target",
		(app) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const entries = yield* app.loader.entries
				const rejected = yield* Effect.flip(
					app.loader.update("forecasts", { config: { artifact: "rejected" } }),
				)
				assert.equal(rejected._tag, "ManagedFork")
				assert.equal(yield* fs.readFileString(app.configFile), app.initialText)
				assert.deepEqual(yield* app.loader.entries, entries)
				assert.equal(
					(yield* app.ask("after", "London")).text,
					"v1 forecast for London",
				)
			}),
	)
}

for (const target of [{ _tag: "Worker", execArgv: [] }, { _tag: "Local" }]) {
	test(
		`${target._tag}: graft start loads managed configuration relative to its file`,
		{ timeout: 30_000 },
		() =>
			Effect.runPromise(
				Effect.gen(function* () {
					const { Artifact } = yield* Effect.promise(
						() => import("@graftland/plugin-remote"),
					)
					const { ChildProcess, ChildProcessSpawner } = yield* Effect.promise(
						() => import("effect/process"),
					)
					const fs = yield* FileSystem.FileSystem
					const root = yield* fs.makeTempDirectoryScoped({
						directory,
						prefix: "cli-",
					})
					yield* fs.makeDirectory(root + "/config")
					const capture = (release) =>
						fs
							.realPath(
								directory + "node_modules/@example/forecasts-" + release,
							)
							.pipe(
								Effect.flatMap((source) =>
									Artifact.capture({
										directory: source,
										entry: "dist/index.js",
										store: root + "/artifacts",
									}),
								),
							)
					const initial = yield* capture("v1")
					const next = yield* capture("v2")
					const input = {
						release: root + "/release",
						started: root + "/started",
					}
					const result = root + "/result.json"
					const entries = [
						{
							id: "forecasts",
							name: "@graftland/plugin-remote",
							config: {
								contract: "@example/forecast-contract",
								artifact: {
									...initial,
									directory:
										"../artifacts/" + initial.directory.split("/").at(-1),
								},
								target,
								config: input,
								probes: ["health"],
							},
						},
						{
							id: "check",
							name: new URL("../host/dist/cli-check.js", import.meta.url).href,
							config: {
								deployment: {
									artifact: next,
									contractModule: import.meta
										.resolve("@example/forecast-contract"),
									target,
									input,
								},
								result,
							},
						},
					]
					yield* fs.writeFileString(
						root + "/config/graft.yml",
						JSON.stringify(entries),
					)
					const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
					const command = ChildProcess.make(process.execPath, [
						new URL(import.meta.resolve("@graftland/cli/bin")).pathname,
						"start",
						root + "/config/graft.yml",
					])
					const output = yield* spawner.string(command)
					assert.ok(output !== undefined)
					const checked = JSON.parse(yield* fs.readFileString(result))
					assert.equal(checked.before, "v1 forecast for London")
					assert.equal(checked.after, "v2 forecast for London")
					assert.equal(checked.outcome._tag, "Accepted")
				}).pipe(
					Effect.scoped,
					Effect.provide(
						NodeServices.layer.pipe(Layer.merge(SecureRandom.layerWebCrypto)),
					),
				),
			),
	)
}
