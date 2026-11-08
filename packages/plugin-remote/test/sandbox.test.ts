// @effect-diagnostics-next-line nodeBuiltinImport:off -- A raw host server the sandboxed unit must not reach.
import { createServer } from "node:http"
import process from "node:process"

import {
	Array,
	Cause,
	Config,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Path,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Units from "../src/Units"
import { budget } from "./unit-binding-fixture"

const fixture = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.makeTempDirectoryScoped({ prefix: "graft-sandbox-" })
	const secretFile = path.join(root, "secret.txt")
	yield* fs.writeFileString(secretFile, "Host-only secret")
	const artifact = yield* Artifact.capture({
		directory: new URL("../.cache/sandbox-canary", import.meta.url).pathname,
		module: "canary.js",
		store: path.join(root, "artifacts"),
	})
	return { secretFile, artifact }
})
const canary = (
	artifact: Artifact.Artifact,
	input: { readonly secretFile: string; readonly port: string },
	placement: Kernel.Placement,
	confinement?: "Sandbox",
) =>
	Units.target({
		artifact,
		contract: "canary.js",
		input,
		placement,
		...(confinement === undefined ? {} : { confinement }),
	})
const kernel = Kernel.layer({
	authority: "sandbox",
	maxUnits: 4,
	instances: [],
}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
const deploy = (target: Kernel.Target) =>
	Change.run({
		operations: [{ _tag: "Deploy", instance: "canary", target }],
		budget,
	})

it.live("rejects a sandboxed Worker before any unit starts", () =>
	Effect.gen(function* () {
		const f = yield* fixture()
		const refused = yield* Effect.flip(
			deploy(
				canary(
					f.artifact,
					{ secretFile: f.secretFile, port: "1" },
					"Worker",
					"Sandbox",
				),
			),
		)
		assert.equal(refused.reason, "UnsupportedTarget")
	}).pipe(
		Effect.provide(kernel),
		Effect.scoped,
		Effect.provide(NodeServices.layer),
	),
)

it.live(
	"admits only sandboxed targets once the operator requires a sandbox",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture()
			const control = yield* Kernel.Kernel
			yield* control.setPolicy({
				instance: "canary",
				sandbox: true,
				values: {},
			})
			const refused = yield* Effect.flip(
				deploy(
					canary(
						f.artifact,
						{ secretFile: f.secretFile, port: "1" },
						"Process",
					),
				),
			)
			assert.equal(refused.reason, "Unauthorized")
		}).pipe(
			Effect.provide(kernel),
			Effect.scoped,
			Effect.provide(NodeServices.layer),
		),
)

it.live.skipIf(process.platform === "linux")(
	"never starts a sandboxed unit unconfined where bubblewrap is unavailable",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture()
			// Even inspection imports the module, so preparation is refused before any unit serves.
			const refused = yield* Effect.flip(
				deploy(
					canary(
						f.artifact,
						{ secretFile: f.secretFile, port: "1" },
						"Process",
						"Sandbox",
					),
				),
			)
			assert.include(
				Cause.pretty(refused.cause ?? Cause.empty),
				"Sandboxed units require Linux bubblewrap",
			)
		}).pipe(
			Effect.provide(kernel),
			Effect.scoped,
			Effect.provide(NodeServices.layer),
		),
)

/** A host HTTP server the sandboxed canary must not reach; yields its port. */
const hostServer = Effect.acquireRelease(
	Effect.callback<{
		readonly server: ReturnType<typeof createServer>
		readonly port: number
	}>((resume) => {
		const server = createServer((_request, response) =>
			response.end("Host network reached"),
		)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			resume(
				typeof address === "object" && address !== null
					? Effect.succeed({ server, port: address.port })
					: Effect.die("The host server has no TCP address"),
			)
		})
	}),
	({ server }) =>
		Effect.callback<void>((resume) => {
			server.close(() => resume(Effect.void))
		}),
)
/** Plants a host secret in the kernel's environment, which a confined unit must not inherit. */
const hostSecret = Effect.acquireRelease(
	Effect.sync(() => {
		// @effect-diagnostics-next-line processEnvInEffect:off -- The fixture plants the secret that the hostile unit must not inherit.
		const previous = process.env["GRAFT_TEST_HOST_SECRET"]
		// @effect-diagnostics-next-line processEnvInEffect:off -- The fixture plants the secret that the hostile unit must not inherit.
		process.env["GRAFT_TEST_HOST_SECRET"] = "Host-only credential"
		return previous
	}),
	(previous) =>
		Effect.sync(() => {
			// @effect-diagnostics-next-line processEnvInEffect:off -- Restore the test-owned environment slot.
			if (previous === undefined) delete process.env["GRAFT_TEST_HOST_SECRET"]
			// @effect-diagnostics-next-line processEnvInEffect:off -- Restore the test-owned environment slot.
			else process.env["GRAFT_TEST_HOST_SECRET"] = previous
		}),
)

it.live.skipIf(process.platform !== "linux")(
	"confines a hostile Process unit: no host files, secrets, network or processes (Linux, bubblewrap)",
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
					"bubblewrap and unprivileged user namespaces are unavailable",
				)
				return
			}
			yield* hostSecret
			const server = yield* hostServer
			const f = yield* fixture()
			const input = { secretFile: f.secretFile, port: `${server.port}` }
			yield* Effect.gen(function* () {
				// Unconfined, the same canary reaches the host and refuses to serve.
				const open = yield* deploy(canary(f.artifact, input, "Process"))
				assert.notEqual(open.outcome, "Accepted")
				assert.include(Cause.pretty(open.cause), "Escaped the sandbox")
				const confined = yield* deploy(
					canary(f.artifact, input, "Process", "Sandbox"),
				)
				assert.equal(confined.outcome, "Accepted", Cause.pretty(confined.cause))
				const control = yield* Kernel.Kernel
				const units = yield* control.units
				assert.isTrue(
					Array.some(
						units,
						(unit) => unit.kind === "Execution" && unit.evidence === "Missing",
					),
				)
			}).pipe(Effect.provide(kernel))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)
