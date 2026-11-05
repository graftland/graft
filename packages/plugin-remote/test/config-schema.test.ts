import { Array, Effect, Schema } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { ConfigSchema } from "@graftland/loader"

import * as Config from "../src/Config"
import { Jwt } from "../src/internal/auth/config"
import { authentication } from "../src/internal/entryConfig"
import { entries } from "../src/schema"

const valid = Schema.is(Schema.toEncoded(Config.Host))
const host = (connect: unknown) => ({
	contract: "./contract.js",
	connect,
	config: {},
})
describe("remote editor schemas", () => {
	it("checks built-in credentials and mutually exclusive connection forms", () => {
		assert.isTrue(valid(host({ local: {} })))
		assert.isTrue(valid(host({ worker: { execArgv: [] } })))
		assert.isTrue(
			valid(
				host({
					url: "wss://localhost",
					auth: { mtls: { cert: "client.crt", key: "client.key" } },
				}),
			),
		)
		assert.isTrue(
			valid(
				host({
					unix: "runner.sock",
					auth: { bearer: { token: { file: "token" } } },
				}),
			),
		)
		assert.isTrue(
			valid(host({ transport: { name: "custom", config: { extra: true } } })),
		)
		assert.isFalse(valid(host({ local: {}, worker: {} })))
		assert.isFalse(valid(host({ command: ["ssh"], auth: { none: {} } })))
		assert.isFalse(
			valid(
				host({
					url: "wss://localhost",
					auth: { mtls: { cert: "client.crt" } },
				}),
			),
		)
		assert.isFalse(
			valid(host({ url: "wss://localhost", auth: { bearer: { token: 42 } } })),
		)
	})
	it.effect("validates JWT settings and durations on runner entries", () =>
		Effect.gen(function* () {
			const decode = Schema.decodeUnknownResult(Config.Runner)
			assert.isTrue(
				decode({ root: ".", state: "state", listen: [{ stdio: true }] })
					._tag === "Success",
			)
			assert.isTrue(
				decode({ root: ".", state: "state", lease: "invalid", listen: [] })
					._tag === "Failure",
			)
			assert.isTrue(
				decode({
					root: ".",
					state: "state",
					listen: [{ stdio: true, auth: { none: {} } }],
				})._tag === "Failure",
			)
			assert.isTrue(
				decode({
					root: ".",
					state: "state",
					listen: [
						{
							url: "ws://localhost",
							auth: {
								jwt: {
									issuer: "issuer",
									audience: ["runner"],
									algorithms: ["HS256"],
									keys: { publicKey: "key.pem" },
								},
							},
						},
					],
				})._tag === "Failure",
			)
			yield* Effect.void
		}),
	)
	it.effect(
		"preserves encoded JWT options until the authenticator decodes them",
		() =>
			Effect.gen(function* () {
				const jwt = {
					issuer: "issuer",
					audience: ["runner"],
					algorithms: ["ES256"],
					clockTolerance: "3 seconds",
					keys: { publicKey: "key.pem" },
				}
				const decoded = yield* Schema.decodeUnknownEffect(
					Config.RunnerAuthentication,
				)({ jwt })
				const reference = authentication("runner", decoded)
				assert.deepEqual(reference.config, jwt)
				yield* Schema.decodeUnknownEffect(Jwt)(reference.config)
			}),
	)
	it("composes its editor registrations into the config file schema", () => {
		const document = ConfigSchema.make({ entries: entries() })
		assert.deepEqual(
			Array.map(
				document.definitions.Entry.allOf ?? [],
				(constraint) => constraint.if.properties.name.enum,
			),
			[
				["remote", "@graftland/plugin-remote"],
				["remote/runner", "@graftland/plugin-remote/runner"],
				["remote/cli", "@graftland/plugin-remote/cli"],
			],
		)
	})
})
