import { application } from "./application"
import { inject } from "vitest"
import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Stream, String } from "effect"
import { WebCrypto } from "effect/crypto"
import { Buffer } from "node:buffer"
import * as pki from "pkijs"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { command } from "../src/internal/runner/command"

const invoke = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const argv = yield* command()
		const child = yield* spawner.spawn(
			ChildProcess.make(argv[0], [...argv.slice(1), ...args], {
				cwd: new URL("..", import.meta.url).pathname,
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
const serve = [
	"serve",
	"--listen",
	"wss://127.0.0.1:0",
	"--auth",
	"mtls",
	"--state",
	"unused-state",
	"--root",
	"unused-root",
	"--cert",
	"unused-cert",
	"--key",
	"unused-key",
	"--ca",
	"unused-ca",
]
describe("remote command line", () => {
	it.live(
		"reports invalid ports and durations as usage errors before reading files",
		() =>
			Effect.gen(function* () {
				const cases: ReadonlyArray<readonly [string, string, string]> = [
					["--listen", "wss://localhost:65536", "URL"],
					["--listen", "wss://localhost:fraction", "URL"],
					["--lease", "0 millis", "finite and positive"],
					["--grace", "Infinity", "finite and positive"],
					["--lease", "soon", "Duration"],
					["--lease", "15000", "Duration"],
				]
				for (const [flag, value, detail] of cases) {
					const result = yield* invoke([...serve, flag, value])
					assert.notEqual(result.code, 0)
					const output = result.stdout + result.stderr
					assert.include(output, detail)
					assert.include(output, "USAGE")
					assert.notInclude(output, "ShowHelp: Help requested")
					assert.notInclude(output, "ENOENT")
				}
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
	it.live("rejects mixing a runner config file with shorthand flags", () =>
		Effect.gen(function* () {
			const result = yield* invoke([
				"serve",
				"--config",
				"missing.yml",
				"--listen",
				"wss://127.0.0.1:0",
			])
			assert.notEqual(result.code, 0)
			assert.include(
				result.stdout + result.stderr,
				"--config cannot be combined",
			)
			assert.include(result.stdout + result.stderr, "ERROR")
			assert.notInclude(result.stdout + result.stderr, "ENOENT")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live(
		"reports listener startup failures before claiming a configured runner is ready",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				yield* application(directory)
				const file = directory + "/runner.yml"
				yield* fs.writeFileString(
					file,
					`
- id: supervisor
  name: '@graftland/plugin-remote/runner/supervisor'
  config: { root: '${inject("remoteRoot")}', state: '${directory}/state' }
- id: auth
  name: '@graftland/plugin-remote/internal/legacy/runner/auth/mtls'
  config: { ca: '${inject("remoteTls")}/ca.crt' }
- id: listener
  name: '@graftland/plugin-remote/internal/legacy/runner/websocket'
  config:
    url: wss://127.0.0.1:0
    cert: missing.crt
    key: '${inject("remoteTls")}/server.key'
    auth: '@graftland/plugin-remote/Auth/MtlsAuthenticator'
`,
				)
				const result = yield* invoke(["serve", "--config", file])
				assert.notEqual(result.code, 0)
				assert.include(
					result.stdout + result.stderr,
					directory + "/missing.crt",
				)
				assert.notInclude(result.stdout, '"event":"Listening"')
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("rejects stdio combined with network or authentication flags", () =>
		Effect.gen(function* () {
			for (const flags of [
				["--listen", "/tmp/unused.sock"],
				["--auth", "none"],
			]) {
				const result = yield* invoke(["serve", "--stdio", ...flags])
				assert.notEqual(result.code, 0)
				assert.include(result.stderr, "--stdio cannot be combined")
				assert.notInclude(result.stderr, "ENOENT")
			}
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live(
		"rejects mismatched and incomplete authentication flags as usage errors",
		() =>
			Effect.gen(function* () {
				const cases = [
					["--auth", "none", "--tokens", "unused"],
					["--auth", "bearer", "--ca", "unused"],
					["--auth", "bearer"],
					["--auth", "jwt", "--identity", "unused"],
					["--auth", "jwt", "--tokens", "unused"],
					["--auth", "jwt"],
					[
						"--auth",
						"jwt",
						"--jwt-jwks",
						"https://unused/keys",
						"--jwt-public-key",
						"unused",
					],
					[
						"--auth",
						"jwt",
						"--jwt-public-key",
						"unused",
						"--jwt-issuer",
						"issuer",
					],
					["--auth", "jwt", "--jwt-algorithm", "HS256"],
					["--auth", "jwt", "--jwt-clock-tolerance", "-1 second"],
					["--auth", "jwt", "--jwt-clock-tolerance", "soon"],
					["--auth", "mtls", "--ca", "unused"],
				]
				for (const flags of cases) {
					const result = yield* invoke([
						"serve",
						"--listen",
						"ws://127.0.0.1:0",
						...flags,
					])
					assert.notEqual(result.code, 0)
					// Handler-level CliError.UserError is rendered as ERROR; parser failures also include USAGE.
					assert.include(result.stdout + result.stderr, "ERROR")
					assert.notInclude(result.stdout + result.stderr, "    at ")
					assert.notInclude(result.stdout + result.stderr, "ENOENT")
				}
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live(
		"reports authenticator startup failure even while its listener is waiting",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const result = yield* invoke([
					"serve",
					"--listen",
					"ws://127.0.0.1:0",
					"--auth",
					"bearer",
					"--tokens",
					directory + "/missing-tokens.json",
					"--state",
					directory + "/state",
					"--root",
					inject("remoteRoot"),
				])
				assert.notEqual(result.code, 0)
				assert.include(result.stderr, "missing-tokens.json")
				assert.notInclude(result.stdout, '"event":"Listening"')
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)

	it.live("describes the child and serve subcommands", () =>
		Effect.gen(function* () {
			const result = yield* invoke(["--help"])
			assert.equal(result.code, 0)
			assert.include(result.stdout, "child")
			assert.include(result.stdout, "serve")
			assert.include(result.stdout, "certificates")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
	it.live(
		"issues certificates, reuses its CA, and requires explicit renewal",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const args = ["certificates", "--out", directory]
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
			const result = yield* invoke([
				"child",
				"unused-contract",
				"session",
				"not-json",
			])
			assert.notEqual(result.code, 0)
			assert.include(result.stdout + result.stderr, "bootstrap")
			assert.notInclude(result.stdout + result.stderr, "watchdog failed")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
