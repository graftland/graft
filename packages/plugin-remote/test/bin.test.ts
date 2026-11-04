import { runnerConfig } from "./application"
import { inject } from "vitest"
import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Stream, String } from "effect"
import { WebCrypto } from "effect/crypto"
import { Buffer } from "node:buffer"
import * as pki from "pkijs"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { cliCommand as command, cliDirectory } from "./application"

const invoke = (args: ReadonlyArray<string>, internal = false) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const argv = internal
			? [
					process.execPath,
					new URL("../dist/internal/childMain.js", import.meta.url).pathname,
				]
			: yield* command
		const child = yield* spawner.spawn(
			ChildProcess.make(argv[0], [...argv.slice(1), ...args], {
				cwd: cliDirectory,
				stdout: "pipe",
				stderr: "pipe",
			}),
		)
		return yield* Effect.all(
			{
				code: child.exitCode,
				stdout: Stream.mkString(Stream.decodeText(child.stdout)),
				stderr: Stream.mkString(Stream.decodeText(child.stderr)),
			},
			{ concurrency: "unbounded" },
		)
	})
describe("remote command line", () => {
	it.live("rejects unsupported start flags", () =>
		Effect.gen(function* () {
			for (const args of [
				["start", "--unknown"],
				["start", "missing.yml", "--listen", "ws://localhost:0"],
				["start", "--config", "missing.yml"],
			]) {
				const result = yield* invoke(args)
				assert.notEqual(result.code, 0)
				assert.include(result.stdout + result.stderr, "USAGE")
				assert.notInclude(result.stdout + result.stderr, "ENOENT")
			}
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
	it.live(
		"reports listener startup failures before claiming a configured runner is ready",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = yield* runnerConfig(
					directory + "/state",
					[
						{
							url: "wss://127.0.0.1:0",
							cert: directory + "/missing.crt",
							key: inject("remoteTls") + "/server.key",
							auth: { mtls: { ca: inject("remoteTls") + "/ca.crt" } },
						},
					],
					{ root: inject("remoteRoot") },
				)
				const result = yield* invoke(["start", file])
				assert.notEqual(result.code, 0)
				assert.include(
					result.stdout + result.stderr,
					directory + "/missing.crt",
				)
				assert.notInclude(result.stdout, '"event":"Listening"')
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live(
		"reports authenticator startup failure even while its listener is waiting",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const config = yield* runnerConfig(
					directory + "/state",
					[
						{
							url: "ws://127.0.0.1:0",
							auth: { bearer: { tokens: directory + "/missing-tokens.json" } },
						},
					],
					{ root: inject("remoteRoot") },
				)
				const result = yield* invoke(["start", config])
				assert.notEqual(result.code, 0)
				assert.include(result.stderr, "missing-tokens.json")
				assert.notInclude(result.stdout, '"event":"Listening"')
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("exits when runner configuration cannot be decoded", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const file = yield* runnerConfig(directory + "/state", [], {
				root: inject("remoteRoot"),
				lease: "not-a-duration",
			})
			const result = yield* invoke(["start", file])
			assert.notEqual(result.code, 0)
			assert.include(result.stderr, "lease")
			assert.notInclude(result.stdout, '"event":"Listening"')
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("describes the remote certificates command", () =>
		Effect.gen(function* () {
			const result = yield* invoke(["remote", "--help"])
			assert.equal(result.code, 0)
			assert.include(result.stdout, "certificates")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
	it.live(
		"issues certificates, reuses its CA, and requires explicit renewal",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const args = ["remote", "certificates", "--out", directory]
				const initial = yield* invoke([
					...args,
					"--server",
					"localhost",
					"--server",
					"127.0.0.1",
					"--server",
					"::1",
					"--identity",
					"billing",
					"--identity",
					"reports",
				])
				assert.equal(initial.code, 0, initial.stdout + initial.stderr)
				const ca = yield* fs.readFileString(directory + "/ca.crt")
				const caKey = yield* fs.readFileString(directory + "/ca.key")
				const original = yield* fs.readFileString(
					directory + "/client-billing.crt",
				)
				const refused = yield* invoke([...args, "--identity", "billing"])
				assert.notEqual(refused.code, 0)
				assert.include(
					refused.stdout + refused.stderr,
					"already exists; use --force",
				)
				// A refusal is a usage error: one line for the operator, no stack trace.
				assert.notInclude(refused.stdout + refused.stderr, "    at ")
				const unchanged = yield* fs.readFileString(
					directory + "/client-billing.crt",
				)
				assert.equal(unchanged, original)
				const additional = yield* invoke([
					...args,
					"--identity",
					"new-host",
					"--days",
					"30",
				])
				assert.equal(additional.code, 0, additional.stdout + additional.stderr)
				const renewed = yield* invoke([
					...args,
					"--identity",
					"billing",
					"--force",
					"--days",
					"30",
				])
				assert.equal(renewed.code, 0, renewed.stdout + renewed.stderr)
				const current = yield* fs.readFileString(
					directory + "/client-billing.crt",
				)
				assert.notEqual(current, original)
				const currentCa = yield* fs.readFileString(directory + "/ca.crt")
				const currentKey = yield* fs.readFileString(directory + "/ca.key")
				assert.equal(currentCa, ca)
				assert.equal(currentKey, caKey)
				const crypto = yield* WebCrypto.WebCrypto
				const engine = new pki.CryptoEngine({ crypto })
				const parse = (pem: string) =>
					pki.Certificate.fromBER(
						new Uint8Array(
							Buffer.from(
								String.replace(/-----[^-]+-----|\s/g, "")(pem),
								"base64",
							),
						),
					)
				const issuer = parse(ca)
				for (const name of [
					"server",
					"client-billing",
					"client-reports",
					"client-new-host",
				]) {
					const pem = yield* fs.readFileString(directory + "/" + name + ".crt")
					assert.notInclude(pem, "\n\n")
					const certificate = parse(pem)
					const valid = yield* Effect.promise(() =>
						certificate.verify(issuer, engine),
					)
					assert.isTrue(valid)
				}
				for (const name of [
					"ca",
					"server",
					"client-billing",
					"client-reports",
					"client-new-host",
				]) {
					const key = yield* fs.readFileString(directory + "/" + name + ".key")
					assert.include(key, "-----BEGIN PRIVATE KEY-----")
					const stat = yield* fs.stat(directory + "/" + name + ".key")
					assert.equal(stat.mode & 0o777, 0o600)
				}
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
	it.live("rejects invalid certificate lifetimes as usage errors", () =>
		Effect.gen(function* () {
			for (const days of ["0", "-1", "1.5", "tomorrow"]) {
				const result = yield* invoke([
					"remote",
					"certificates",
					"--out",
					"unused-certificates",
					"--days",
					days,
				])
				assert.notEqual(result.code, 0)
				assert.include(result.stdout + result.stderr, "USAGE")
			}
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("validates the supervised bootstrap before starting a watchdog", () =>
		Effect.gen(function* () {
			const result = yield* invoke(
				["child", "unused-contract", "session", "not-json"],
				true,
			)
			assert.notEqual(result.code, 0)
			assert.include(result.stdout + result.stderr, "bootstrap")
			assert.notInclude(result.stdout + result.stderr, "watchdog failed")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
