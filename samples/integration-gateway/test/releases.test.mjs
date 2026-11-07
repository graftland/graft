import assert from "node:assert/strict"
import { test } from "node:test"

import {
	ConfigProvider,
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Ref,
	Schedule,
	Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import { Control, plugin as releasePlugin } from "@graftland/plugin-release"
import { Artifact } from "@graftland/plugin-remote"

import { startReleases } from "../host/dist/release-app.js"

const runtime = Graft.layer.pipe(
	Layer.provideMerge(
		Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
	),
)
const directory = new URL("../", import.meta.url).pathname
const input = (prefix) => ({ release: "unused", started: "unused", prefix })

test(
	"a killed host restarts the last accepted release rather than an unfinished intent",
	{ timeout: 120_000 },
	() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const app = yield* startReleases(directory, {
					_tag: "Worker",
					execArgv: [],
				})
				const fs = yield* FileSystem.FileSystem
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const accepted = yield* app.build(input("accepted"))
				yield* app.releases.apply({ target: accepted, expected: app.initial })
				const pending = yield* app.build({
					...input("pending"),
					holdProbe: true,
				})
				yield* app.releaseFork.dispose
				const socket = app.root + "/restart.sock"
				const file = app.root + "/host.yml"
				yield* fs.writeFileString(
					file,
					JSON.stringify([
						{
							id: "releases",
							name: "@graftland/plugin-release",
							config: {
								store: "./store",
								initial: app.initial,
								host: app.options.host,
								socket: "./restart.sock",
							},
						},
					]),
				)
				const command = ChildProcess.make(
					process.execPath,
					[
						new URL(import.meta.resolve("@graftland/cli/bin")).pathname,
						"start",
						file,
					],
					{ cwd: directory, stdout: "inherit", stderr: "inherit" },
				)
				const awaitReady = Control.call(socket, { _tag: "status" }).pipe(
					Effect.retry(Schedule.spaced("20 millis")),
					Effect.timeout("15 seconds"),
				)
				const first = yield* spawner.spawn(command)
				assert.equal((yield* awaitReady).value.current, accepted)
				const applying = yield* Effect.forkScoped(
					Control.call(socket, {
						_tag: "apply",
						request: { target: pending, expected: accepted },
					}).pipe(Effect.exit),
				)
				yield* fs.readFileString(app.store + "/journal.json").pipe(
					Effect.map((text) => JSON.parse(text)),
					Effect.repeat({
						schedule: Schedule.spaced("10 millis"),
						until: (journal) =>
							journal.status.state === "Applying" &&
							journal.events.at(-1).target === pending,
					}),
					Effect.timeout("10 seconds"),
				)
				yield* first.kill({ killSignal: "SIGKILL" })
				assert.equal((yield* Fiber.join(applying))._tag, "Failure")
				const second = yield* spawner.spawn(command)
				const restored = yield* awaitReady
				assert.equal(restored.value.current, accepted)
				assert.equal(restored.value.state, "Ready")
				const journal = JSON.parse(
					yield* fs.readFileString(app.store + "/journal.json"),
				)
				assert.equal(journal.events.at(-1).kind, "Startup")
				assert.equal(journal.events.at(-1).target, accepted)
				assert.ok(
					journal.events.some(
						(event) => event.kind === "Intent" && event.target === pending,
					),
				)
				assert.ok(
					!journal.events.some(
						(event) => event.kind === "Commit" && event.target === pending,
					),
				)
				yield* second.kill()
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		),
)

for (const target of [{ _tag: "Worker", execArgv: [] }, { _tag: "Local" }]) {
	test(
		`${target._tag}: immutable config releases preserve the WebSocket session`,
		{ timeout: 120_000 },
		() =>
			Effect.runPromise(
				Effect.gen(function* () {
					const app = yield* startReleases(directory, target)
					const fs = yield* FileSystem.FileSystem
					assert.equal(
						(yield* app.ask("London")).text,
						"initial forecast for London",
					)
					const good = yield* app.build(input("good"))
					assert.equal(yield* app.build(input("good")), good)
					const planned = yield* app.releases.plan(good)
					assert.deepEqual(planned.diagnostics, [])
					assert.deepEqual(planned.changes, [
						{ entry: "forecasts", reasons: ["config"] },
					])
					const accepted = yield* app.releases.apply({
						target: good,
						expected: app.initial,
					})
					assert.equal(accepted.outcomes[0].outcome._tag, "Accepted")
					assert.equal(accepted.status.current, good)
					const sourceText = yield* fs.readFileString(app.file)
					const sourceEntries = JSON.parse(sourceText)
					const buildSource = (entries) =>
						fs.writeFileString(app.file, JSON.stringify(entries)).pipe(
							Effect.andThen(
								app.releases.build({
									file: app.file,
									references: [],
									revocations: [],
								}),
							),
						)
					const removed = yield* buildSource([])
					assert.deepEqual((yield* app.releases.plan(removed)).changes, [
						{ entry: "forecasts", reasons: ["removed"] },
					])
					assert.equal(
						(yield* Effect.flip(
							app.releases.apply({ target: removed, expected: good }),
						)).code,
						"Plan",
					)
					const added = yield* buildSource([
						...sourceEntries,
						{ ...sourceEntries[0], id: "another" },
					])
					assert.deepEqual((yield* app.releases.plan(added)).changes, [
						{ entry: "another", reasons: ["added"] },
					])
					assert.equal(
						(yield* Effect.flip(
							app.releases.apply({ target: added, expected: good }),
						)).code,
						"Plan",
					)
					yield* fs.writeFileString(app.file, sourceText)
					const implementation =
						sourceEntries[0].config.package + "/dist/index.js"
					const codeTarget = yield* Effect.acquireUseRelease(
						fs.readFileString(implementation),
						(original) =>
							fs
								.writeFileString(
									implementation,
									original + "\n// Implementation revision.\n",
								)
								.pipe(
									Effect.andThen(
										app.releases.build({
											file: app.file,
											references: [],
											revocations: [],
										}),
									),
								),
						(original) =>
							fs.writeFileString(implementation, original).pipe(Effect.orDie),
					)
					assert.deepEqual((yield* app.releases.plan(codeTarget)).changes, [
						{ entry: "forecasts", reasons: ["code"] },
					])
					assert.equal(
						(yield* app.ask("London")).text,
						"good forecast for London",
					)
					assert.ok(
						accepted.outcomes[0].outcome.evidence.some(
							(item) => item.termination?.state === "Exited",
						),
					)
					const invalid = yield* app.build(input(42))
					assert.equal(
						(yield* app.releases.plan(invalid)).diagnostics[0].code,
						"Configuration",
					)
					assert.equal(
						(yield* Effect.flip(
							app.releases.apply({ target: invalid, expected: good }),
						)).code,
						"Plan",
					)
					const unhealthy = yield* app.build({
						...input("broken"),
						unhealthy: true,
					})
					assert.deepEqual(
						(yield* app.releases.plan(unhealthy)).diagnostics,
						[],
					)
					const aborted = yield* app.releases.apply({
						target: unhealthy,
						expected: good,
					})
					assert.equal(aborted.outcomes[0].outcome._tag, "Aborted")
					assert.ok(
						aborted.outcomes[0].outcome.evidence.some((item) => item.cause),
					)
					assert.equal(aborted.status.current, good)
					const held = yield* app.build({
						...input("cancelled caller"),
						holdProbe: true,
					})
					const caller = yield* Effect.forkScoped(
						app.releases.apply({ target: held, expected: good }),
					)
					yield* fs.readFileString(app.store + "/journal.json").pipe(
						Effect.map((text) => JSON.parse(text)),
						Effect.repeat({
							schedule: Schedule.spaced("5 millis"),
							until: (journal) =>
								journal.status.state === "Applying" &&
								journal.events.at(-1).target === held,
						}),
						Effect.timeout("10 seconds"),
					)
					yield* Fiber.interrupt(caller)
					yield* app.releases.history.pipe(
						Effect.repeat({
							schedule: Schedule.spaced("10 millis"),
							until: (events) =>
								events.some(
									(event) => event.kind === "Outcome" && event.target === held,
								),
						}),
						Effect.timeout("10 seconds"),
					)
					yield* app.releases.observe.pipe(
						Effect.repeat({
							schedule: Schedule.spaced("10 millis"),
							until: (status) => status.state === "Ready",
						}),
						Effect.timeout("10 seconds"),
					)
					assert.ok(
						(yield* app.releases.history).some(
							(event) =>
								event.kind === "Outcome" &&
								event.target === held &&
								event.outcome._tag === "Aborted",
						),
					)
					assert.equal(
						(yield* app.ask("London")).text,
						"good forecast for London",
					)
					const rollback = yield* app.releases.rollback(good)
					assert.equal(rollback.status.current, app.initial)
					assert.equal(rollback.outcomes[0].outcome._tag, "Accepted")
					assert.equal(
						(yield* app.ask("London")).text,
						"initial forecast for London",
					)
					const revoked = yield* app.build(input("revoked"), [
						"credential:legacy",
					])
					yield* app.releases.apply({ target: revoked, expected: app.initial })
					assert.equal(
						(yield* Effect.flip(app.releases.rollback(revoked))).code,
						"Plan",
					)
					assert.ok(
						(yield* app.releases.plan(app.initial)).diagnostics.some(
							(item) =>
								item.code === "Revoked" &&
								item.message.includes("credential:legacy"),
						),
					)
					assert.equal(
						(yield* app.ask("London")).text,
						"revoked forecast for London",
					)
					const override = yield* app.releases.rollback(revoked, true)
					assert.equal(override.status.current, app.initial)
					assert.deepEqual(override.status.revocations, ["credential:legacy"])
					const secret = yield* app.build({
						...input("secret"),
						credential: { $env: "RELEASE_TEST_TOKEN" },
					})
					const secretResult = yield* app.releases.apply({
						target: secret,
						expected: app.initial,
					})
					assert.equal(secretResult.outcomes[0].outcome._tag, "Accepted")
					for (const file of [
						"journal.json",
						`${secret}/release.json`,
						`${secret}/graft.yml`,
						`${secret}/manifests.json`,
					])
						assert.ok(
							!(yield* fs.readFileString(`${app.store}/${file}`)).includes(
								"sensitive-test-token",
							),
						)
					const conflict = yield* Effect.flip(
						app.releases.apply({ target: good, expected: app.initial }),
					)
					assert.equal(conflict.code, "Conflict")
					const status = yield* Control.call(app.socket, { _tag: "status" })
					assert.equal(status.ok, true)
					assert.equal(status.value.current, secret)
					const rejected = yield* Control.call(app.socket, {
						_tag: "plan",
						target: invalid,
					})
					assert.equal(rejected.ok, false)
					const history = yield* app.releases.history
					assert.ok(
						history.some(
							(event) =>
								event.kind === "Rejected" && event.target === unhealthy,
						),
					)
					assert.equal(yield* Ref.get(app.upstream.session), app.session)
					assert.equal(yield* Ref.get(app.upstream.logins), 1)
					assert.equal(yield* Ref.get(app.gatewayActivations), 1)
					assert.equal(yield* Ref.get(app.consumerActivations), 1)
					assert.equal(app.session, "session-1")
					assert.ok((yield* Ref.get(app.upstream.heartbeats)) > 0)
					// Verification covers every byte, not just the release manifest.
					yield* fs.writeFileString(`${app.store}/${good}/graft.yml`, "[]")
					assert.equal(
						(yield* Effect.flip(app.releases.plan(good))).code,
						"Integrity",
					)
				}).pipe(
					Effect.scoped,
					Effect.provide([
						runtime,
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({
								RELEASE_TEST_TOKEN: "sensitive-test-token",
							}),
						),
					]),
				),
			),
	)
}

test(
	"a later entry failure compensates earlier accepted entries",
	{ timeout: 120_000 },
	() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const app = yield* startReleases(
					directory,
					{ _tag: "Worker", execArgv: [] },
					true,
				)
				const target = yield* app.build(input("candidate"), [], [], {
					...input("audit"),
					unhealthy: true,
				})
				const outcome = yield* app.releases.apply({
					target,
					expected: app.initial,
				})
				assert.deepEqual(
					outcome.outcomes.map((item) => [
						item.entry,
						item.compensation,
						item.outcome._tag,
					]),
					[
						["forecasts", false, "Accepted"],
						["audit", false, "Aborted"],
						["forecasts", true, "Accepted"],
					],
				)
				assert.equal(outcome.status.current, app.initial)
				assert.equal(outcome.status.state, "Ready")
				assert.equal(
					(yield* app.ask("London")).text,
					"initial forecast for London",
				)
				assert.equal(yield* Ref.get(app.upstream.logins), 1)
				assert.equal(yield* Ref.get(app.consumerActivations), 1)
				assert.ok(
					(yield* app.releases.history).some(
						(event) => event.kind === "Compensation",
					),
				)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		),
)

test(
	"release commands reach the running application and use CI exit codes",
	{ timeout: 120_000 },
	() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const app = yield* startReleases(directory, { _tag: "Local" })
				const fs = yield* FileSystem.FileSystem
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const cliDirectory = app.root + "/cli"
				yield* fs.makeDirectory(cliDirectory)
				yield* fs.writeFileString(
					cliDirectory + "/graft.yml",
					'- name: "@graftland/plugin-release/cli"\n  cli: true\n',
				)
				const command = (...args) =>
					ChildProcess.make(
						process.execPath,
						[
							new URL(import.meta.resolve("@graftland/cli/bin")).pathname,
							"release",
							...args,
							"--socket",
							app.socket,
							"--json",
						],
						{ cwd: cliDirectory },
					)
				const status = JSON.parse(yield* spawner.string(command("status")))
				assert.equal(status.ok, true)
				assert.equal(status.value.current, app.initial)
				const target = yield* app.build(input("cli"))
				const built = JSON.parse(
					yield* spawner.string(command("build", app.file)),
				)
				assert.equal(built.ok, true)
				assert.equal(built.value, target)
				const planOutput = yield* spawner.string(command("plan", target))
				assert.equal(JSON.parse(planOutput).ok, true, planOutput)
				const code = Number(yield* spawner.exitCode(command("plan", target)))
				const diagnostic =
					code === 0
						? ""
						: yield* spawner.string(command("plan", target), {
								includeStderr: true,
							})
				assert.equal(code, 0, diagnostic)
				const applied = yield* Effect.scoped(
					Effect.gen(function* () {
						const child = yield* spawner.spawn(
							command("apply", target, "--expected", app.initial),
						)
						const [code, chunks] = yield* Effect.all(
							[child.exitCode, Stream.runCollect(child.all)],
							{ concurrency: 2 },
						)
						return {
							code: Number(code),
							output: new TextDecoder().decode(Buffer.concat(chunks)),
						}
					}),
				)
				assert.equal(applied.code, 0, applied.output)
				assert.equal((yield* app.releases.observe).current, target)
				assert.notEqual(
					Number(
						yield* spawner.exitCode(
							command("apply", target, "--expected", app.initial),
						),
					),
					0,
				)
				assert.equal(
					Number(
						yield* spawner.exitCode(command("rollback", "--expected", target)),
					),
					0,
				)
				assert.equal(
					JSON.parse(yield* spawner.string(command("history"))).ok,
					true,
				)
				assert.equal(yield* Ref.get(app.upstream.logins), 1)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		),
)

for (const target of [{ _tag: "Worker" }, { _tag: "Local" }]) {
	test(
		`${target._tag}: relative contracts use the same execution URL and planning imports release their leases`,
		{ timeout: 120_000 },
		() =>
			Effect.runPromise(
				Effect.gen(function* () {
					const app = yield* startReleases(directory, target)
					const fs = yield* FileSystem.FileSystem
					const source = JSON.parse(yield* fs.readFileString(app.file))
					assert.ok(source[0].config.contract.startsWith(".."))
					const stored = JSON.parse(
						yield* fs.readFileString(
							app.store + "/" + app.initial + "/release.json",
						),
					)
					assert.equal(
						stored.entries[0].contract,
						import.meta.resolve("@example/forecast-contract"),
					)
					assert.equal(yield* Ref.get(app.leases), 1)
					assert.equal(yield* Ref.get(app.observations), 1)
					const invalid = yield* app.build(input(42))
					for (const target of [
						app.initial,
						invalid,
						app.initial,
						invalid,
						app.initial,
					]) {
						const plan = yield* app.releases.plan(target)
						assert.equal(plan.diagnostics.length, target === invalid ? 1 : 0)
						assert.equal(yield* Ref.get(app.leases), 1)
						assert.equal(yield* Ref.get(app.observations), 1)
					}
					assert.equal(
						(yield* app.ask("London")).text,
						"initial forecast for London",
					)
					yield* app.releaseFork.dispose
					assert.equal(yield* Ref.get(app.leases), 0)
					assert.equal(yield* Ref.get(app.observations), 0)
				}).pipe(Effect.scoped, Effect.provide(runtime)),
			),
	)
}

test(
	"restart inspects only the accepted release after an obsolete external dependency is removed",
	{ timeout: 120_000 },
	() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const implementation = new URL(
					import.meta.resolve("@example/forecasts-release"),
				).pathname
				const legacy = directory + "legacy.js"
				yield* fs.writeFileString(legacy, "export const legacy = true")
				const app = yield* Effect.acquireUseRelease(
					fs.readFileString(implementation),
					(original) =>
						fs
							.writeFileString(
								implementation,
								"import " +
									JSON.stringify(
										new URL("legacy.js", new URL("../", import.meta.url)).href,
									) +
									";\n" +
									original,
							)
							.pipe(
								Effect.andThen(startReleases(directory, { _tag: "Worker" })),
							),
					(original) =>
						fs.writeFileString(implementation, original).pipe(Effect.orDie),
				)
				const accepted = yield* app.build(input("current"))
				const applied = yield* app.releases.apply({
					target: accepted,
					expected: app.initial,
				})
				assert.equal(applied.outcomes[0].outcome._tag, "Accepted")
				yield* fs.remove(legacy)
				assert.equal(
					(yield* Artifact.directoryIdentity(app.store + "/" + app.initial))
						.digest,
					app.initial,
				)
				assert.deepEqual((yield* app.releases.plan(accepted)).diagnostics, [])
				yield* app.releaseFork.dispose
				const restarted = yield* Graft.plugin(releasePlugin(app.options))
				yield* restarted.await
				assert.equal(
					(yield* Control.call(app.socket, { _tag: "status" })).value.current,
					accepted,
				)
				assert.equal(
					(yield* app.ask("London")).text,
					"current forecast for London",
				)
				const history = (yield* Control.call(app.socket, { _tag: "history" }))
					.value
				assert.equal(history.at(-1).kind, "Startup")
				assert.equal(history.at(-1).target, accepted)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		),
)
