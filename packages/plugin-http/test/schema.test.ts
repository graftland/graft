import { Array, Effect, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Config, JwtConfig, OAuthConfig } from "../src/Config.ts"
import * as Http from "../src/Http.ts"
import { entries } from "../src/schema.ts"

it("exports both names and requires configuration in the editor", () => {
	const [entry] = entries()
	assert.deepStrictEqual(entry?.names, ["@graftland/plugin-http", "http"])
	assert.strictEqual(entry?.required, true)
	assert.nestedPropertyVal(
		entry?.schema,
		"properties.host.default",
		"127.0.0.1",
	)
	assert.deepInclude(entry?.schema, {
		type: "object",
		required: ["port"],
		additionalProperties: false,
	})
})
it.effect("decodes an environment port and the schema's loopback default", () =>
	Effect.gen(function* () {
		const decoded = yield* Schema.decodeEffect(Config)({ port: "0" })
		assert.deepStrictEqual(decoded, { port: 0, host: "127.0.0.1" })
		for (const port of [-1, 65536, "65536", "1.2", "Infinity", "oops"]) {
			const accepted = yield* Effect.isSuccess(
				Schema.decodeEffect(Config)({ port }),
			)
			assert.isFalse(accepted)
		}
	}),
)

it.effect("keeps string ports within range in runtime and editor schemas", () =>
	Effect.gen(function* () {
		const document = yield* Schema.decodeUnknownEffect(
			Schema.Struct({
				properties: Schema.Struct({
					port: Schema.Struct({
						anyOf: Schema.Array(
							Schema.Struct({ pattern: Schema.optionalKey(Schema.String) }),
						),
					}),
				}),
			}),
		)(entries()[0]?.schema)
		const pattern = document.properties.port.anyOf[1]?.pattern
		if (pattern === undefined) return assert.fail("Missing string port pattern")
		const matches = new RegExp(pattern)
		for (let port = 0; port <= 65535; port++)
			assert.isTrue(matches.test(String(port)), `Port ${port}`)
		for (const port of ["0", "00080", "65535"]) {
			const decoded = yield* Schema.decodeEffect(Config)({ port })
			assert.equal(decoded.port, Number(port))
			assert.isTrue(matches.test(port))
		}
		for (const port of [
			"",
			"oops",
			"65536",
			"99999",
			"-1",
			"1.5",
			"1e2",
			"0x50",
			"80\n",
			" 80",
		]) {
			assert.isFalse(matches.test(port), port)
			const accepted = yield* Effect.isSuccess(
				Schema.decodeEffect(Config)({ port }),
			)
			assert.isFalse(accepted, port)
		}
	}),
)

it("uses deterministic public key strings", () => {
	assert.strictEqual(Http.Server.key, "@graftland/plugin-http/Http/Server")
	assert.strictEqual(Http.Mounts.key, "@graftland/plugin-http/Http/Mounts")
	assert.strictEqual(
		Http.MountsChanged.key,
		"@graftland/plugin-http/Http/MountsChanged",
	)
	assert.strictEqual(Http.Routes.key, "@graftland/plugin-http/Http/Routes")
})

it.effect(
	"registers OAuth entries and rejects unusable resource and JWKS URLs",
	() =>
		Effect.gen(function* () {
			assert.deepStrictEqual(
				Array.map(Array.drop(entries(), 1), (entry) => entry.names),
				[
					["@graftland/plugin-http/router", "http/router"],
					["@graftland/plugin-http/oauth", "http/oauth"],
					["@graftland/plugin-http/oauth/jwt", "http/oauth/jwt"],
				],
			)
			assert.nestedProperty(entries()[2]?.schema, "properties.resource.pattern")
			assert.nestedProperty(
				entries()[2]?.schema,
				"properties.authorizationServers.items[0].pattern",
			)
			assert.nestedProperty(entries()[3]?.schema, "properties.issuer.pattern")
			assert.nestedProperty(
				entries()[3]?.schema,
				"properties.jwksUrl.allOf[0].pattern",
			)
			for (const resource of [
				"https://",
				"https://user:secret@example.com/mcp",
				"https://example.com/mcp#fragment",
			]) {
				const accepted = yield* Effect.isSuccess(
					Schema.decodeEffect(OAuthConfig)({
						resource,
						authorizationServers: ["https://issuer.example"],
					}),
				)
				assert.isFalse(accepted)
			}
			const accepted = yield* Effect.isSuccess(
				Schema.decodeEffect(JwtConfig)({
					issuer: "https://issuer.example",
					audience: "resource",
					jwksUrl: "http://issuer.example/jwks",
				}),
			)
			assert.isFalse(accepted)
		}),
)
