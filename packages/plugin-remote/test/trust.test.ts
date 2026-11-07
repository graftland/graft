// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer needs a native server factory for the isolation test.
import { createServer } from "node:http"
import process from "node:process"

import {
	Cause,
	Config,
	Context,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Ref,
	Schema,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpClient, HttpServerResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as Remote from "../src/index"
import * as Policy from "../src/Policy"
import { Attack, contract } from "./fixtures/untrusted-contract"

const runtime = Graft.layer.pipe(
	Layer.provideMerge(
		Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
	),
)
const fake: Remote.Sandbox.Launcher["Service"] = {
	prepare: (request) =>
		Effect.succeed({
			command: [
				process.execPath,
				new URL("../dist/sandbox/child.js", import.meta.url).pathname,
			],
			contractModule: new URL(
				"file://" + request.artifact.directory + "/untrusted-plugin.js",
			).href,
			implementation: new URL(
				"file://" + request.artifact.directory + "/untrusted-plugin.js",
			).href,
		}),
}
const setup = Effect.fnUntraced(function* (
	launcher: Remote.Sandbox.Launcher["Service"] | undefined,
	target: Remote.CandidateOptions["target"] = { _tag: "Local" },
) {
	const fs = yield* FileSystem.FileSystem
	const root = yield* fs.makeTempDirectoryScoped({ prefix: "graft-trust-" })
	const artifact = yield* Remote.Artifact.capture({
		directory: new URL("../.cache/untrusted", import.meta.url).pathname,
		entry: "untrusted-plugin.js",
		store: root + "/artifacts",
	})
	const data = root + "/data"
	yield* fs.makeDirectory(data)
	yield* fs.writeFileString(data + "/allowed.txt", "Granted data")
	yield* fs.writeFileString(root + "/secret.txt", "Host secret")
	const identity = {
		package: "@example/untrusted",
		digest: artifact.identity.digest,
	}
	const authority = yield* Policy.install({
		version: "1",
		entries: [
			{
				entry: "untrusted",
				artifact: identity,
				tier: "untrusted",
				contractEntry: "untrusted-plugin.js",
				grants: [
					{ _tag: "Files", id: "data", directory: data },
					{
						_tag: "Http",
						id: "weather",
						origin: "https://weather.example",
						credential: "WEATHER_KEY",
					},
				],
			},
		],
	})
	const fork = yield* Graft.plugin(
		Remote.plugin(contract, {
			instance: "untrusted",
			artifact,
			contractModule: new URL(
				"file://" + artifact.directory + "/untrusted-plugin.js",
			).href,
			target,
			policy: {
				startup: "2 seconds",
				total: "30 seconds",
				terminate: "500 millis",
				stop: 100,
				drain: 100,
				trial: 0,
			},
		}),
		{},
	).pipe(
		Effect.provideService(Remote.Sandbox.Current, launcher),
		Effect.provideService(Policy.Service, authority),
	)
	return { fork, root, identity, artifact, target, authority }
})
const client = Effect.gen(function* () {
	const found = yield* Deferred.make<Attack["Service"]>()
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "trusted-consumer",
			inject: [Attack],
			apply: () =>
				Effect.flatMap(Attack, (value) =>
					Deferred.succeed(found, value).pipe(Effect.asVoid),
				),
		}),
	)
	yield* consumer.await
	return yield* Deferred.await(found)
})
const approve = (identity: Policy.Identity, authority: Policy.Operations) =>
	Effect.gen(function* () {
		const expected = yield* authority.statement("untrusted", identity)
		const approval = yield* authority.review({ expected, who: "test operator" })
		yield* authority.approve(approval)
	})
const reason = (error: unknown) => {
	assert.isTrue(
		Schema.is(
			Schema.Struct({ reason: Schema.Struct({ cause: Policy.Unapproved }) }),
		)(error),
	)
	if (
		Schema.is(
			Schema.Struct({ reason: Schema.Struct({ cause: Policy.Unapproved }) }),
		)(error)
	)
		return error.reason.cause.reason
	throw new Error("Expected a facade admission rejection")
}
it.live(
	"fake launcher exercises approval, broker denials, description changes and revocation on every platform",
	() =>
		Effect.gen(function* () {
			const h = yield* setup(fake)
			yield* h.fork.await
			const api = yield* client
			const unapproved = yield* api
				.run({ action: "read", value: "allowed.txt" })
				.pipe(Effect.flip)
			assert.equal(reason(unapproved), "MissingApproval")
			yield* approve(h.identity, h.authority)
			const allowed = yield* api.run({
				action: "read",
				value: "allowed.txt",
			})
			assert.equal(allowed, "Granted data")
			const escaped = yield* api.run({
				action: "read",
				value: "../secret.txt",
			})
			assert.equal(escaped, "FileDenied")
			const destination = yield* api.run({
				action: "http",
				value: "https://not-allowed.example",
			})
			assert.equal(destination, "DestinationDenied")
			yield* Policy.publish({
				projection: "mcp/tools",
				view: "forecast-tools",
				values: [
					{
						service: Attack.key,
						operation: "@graftland/test/untrusted/run@1",
						value: {
							name: "attack",
							title: "Attack",
							description: "Changed description",
							readOnlyHint: false,
							destructiveHint: true,
							idempotentHint: false,
							openWorldHint: true,
							output: "json",
						},
					},
				],
			})
			const changed = yield* api
				.run({ action: "read", value: "allowed.txt" })
				.pipe(Effect.flip)
			assert.equal(reason(changed), "ChangedStatement")
			yield* approve(h.identity, h.authority)
			const pidText = yield* api.run({ action: "pid", value: "" })
			const pid = Number(pidText)
			yield* h.authority.revoke(["data"])
			const revoked = yield* api
				.run({ action: "read", value: "allowed.txt" })
				.pipe(Effect.flip)
			assert.equal(reason(revoked), "Revoked")
			assert.throws(() => process.kill(pid, 0), /ESRCH/)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)
for (const target of [{ _tag: "Worker" } as const, { _tag: "Local" } as const])
	it.live("rejects untrusted " + target._tag + " without a launcher", () =>
		Effect.gen(function* () {
			const h = yield* setup(undefined, target)
			const exit = yield* h.fork.await.pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.include(
					Cause.pretty(exit.cause),
					target._tag === "Worker"
						? "Workers are not a security boundary"
						: "No sandbox launcher",
				)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
	)
it.live.skipIf(process.platform === "linux")(
	"fails closed when the Linux launcher is selected on an unsupported platform",
	() =>
		Effect.gen(function* () {
			const context = yield* Layer.build(Remote.Sandbox.linux)
			const launcher = Context.get(context, Remote.Sandbox.Launcher)
			const failure = yield* Deferred.make<Remote.Sandbox.SandboxError>()
			const h = yield* setup({
				prepare: (request) =>
					launcher
						.prepare(request)
						.pipe(Effect.tapError((error) => Deferred.succeed(failure, error))),
			})
			const result = yield* h.fork.await.pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(result))
			if (Exit.isFailure(result)) {
				const denied = yield* Deferred.await(failure)
				assert.equal(denied.reason, "LauncherUnavailable")
				assert.include(Cause.pretty(result.cause), "Linux bubblewrap launcher")
			}
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)
it.live.skipIf(process.platform !== "linux")(
	"Linux bubblewrap blocks files, secrets and network (requires Linux user namespaces and bubblewrap)",
	(context) =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const available = yield* spawner
				.exitCode(
					ChildProcess.make("bwrap", [
						"--unshare-user",
						"--unshare-net",
						"--ro-bind",
						"/",
						"/",
						"--",
						"true",
					]),
				)
				.pipe(Effect.exit)
			if (Exit.isFailure(available) || available.value !== 0) {
				// CI sets this so the confinement suite cannot silently skip.
				const required = yield* Config.Boolean("GRAFT_REQUIRE_SANDBOX").pipe(
					Config.withDefault(false),
				)
				if (required)
					assert.fail(
						"GRAFT_REQUIRE_SANDBOX is set, but bubblewrap cannot create user and network namespaces: " +
							(Exit.isFailure(available)
								? Cause.pretty(available.cause)
								: "bwrap exited with " + available.value),
					)
				context.skip(
					"bubblewrap and unprivileged user/network namespaces are unavailable",
				)
				return
			}
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					// @effect-diagnostics-next-line processEnvInEffect:off -- This fixture plants the secret that the malicious child must not inherit.
					const previous = process.env["GRAFT_TEST_HOST_SECRET"]
					// @effect-diagnostics-next-line processEnvInEffect:off -- This fixture plants the secret that the malicious child must not inherit.
					process.env["GRAFT_TEST_HOST_SECRET"] = "Host-only credential"
					return previous
				}),
				(previous) =>
					Effect.sync(() => {
						if (previous === undefined) {
							// @effect-diagnostics-next-line processEnvInEffect:off -- Restore the test-owned environment slot.
							delete process.env["GRAFT_TEST_HOST_SECRET"]
						}
						// @effect-diagnostics-next-line processEnvInEffect:off -- Restore the test-owned environment slot.
						else process.env["GRAFT_TEST_HOST_SECRET"] = previous
					}),
			)
			const requests = yield* Ref.make(0)
			const server = yield* NodeHttpServer.make(createServer, {
				host: "127.0.0.1",
				port: 0,
			})
			yield* server.serve(
				Ref.update(requests, (count) => count + 1).pipe(
					Effect.as(HttpServerResponse.text("Host network reached")),
				),
			)
			assert.notEqual(server.address._tag, "UnixPathAddress")
			const port =
				server.address._tag === "UnixPathAddress" ? 0 : server.address.port
			const destination = "http://127.0.0.1:" + port
			const httpContext = yield* Layer.build(FetchHttpClient.layer)
			const http = Context.get(httpContext, HttpClient.HttpClient)
			const control = yield* http
				.get(destination)
				.pipe(Effect.flatMap((response) => response.text))
			assert.equal(control, "Host network reached")
			const layer = yield* Layer.build(Remote.Sandbox.linux)
			const launcher = Context.get(layer, Remote.Sandbox.Launcher)
			const h = yield* setup(launcher)
			yield* h.fork.await
			const api = yield* client
			yield* approve(h.identity, h.authority)
			const ungrantedFile = yield* api.run({
				action: "file",
				value: h.root + "/secret.txt",
			})
			assert.equal(ungrantedFile, "ERR_ACCESS_DENIED")
			const secret = yield* api.run({
				action: "environment",
				value: "GRAFT_TEST_HOST_SECRET",
			})
			assert.equal(secret, "EnvironmentDenied")
			const network = yield* api.run({
				action: "network",
				value: destination,
			})
			assert.equal(network, "NetworkDenied")
			const reached = yield* Ref.get(requests)
			assert.equal(reached, 1)
			const grantedFile = yield* api.run({
				action: "read",
				value: "allowed.txt",
			})
			assert.equal(grantedFile, "Granted data")
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.live("retires each attempt binding across repeated direct transitions", () =>
	Effect.gen(function* () {
		const h = yield* setup(fake)
		yield* h.fork.await
		for (let revision = 0; revision < 4; revision++) {
			const outcome = yield* Graft.transition({
				target: "untrusted",
				candidate: Remote.candidate({
					artifact: h.artifact,
					contractModule: new URL(
						"file://" + h.artifact.directory + "/untrusted-plugin.js",
					).href,
					target: h.target,
					input: { revision },
				}),
			})
			assert.equal(outcome._tag, "Accepted")
			const observed1 = yield* h.authority.bindings
			assert.equal(observed1, 1)
		}
		yield* h.fork.dispose
		const observed2 = yield* h.authority.bindings
		assert.equal(observed2, 0)
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)
