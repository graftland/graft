import { Cause, Effect, Exit, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Config } from "../src/Config.ts"
import server from "../src/index.ts"
import { request, run, start } from "./utils.ts"

it.live("binds loopback and publishes the assigned port", () =>
	Effect.gen(function* () {
		const { url, address } = yield* start
		assert.match(url, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/)
		assert.strictEqual(address._tag, "InetAddressV4")
		if (address._tag === "InetAddressV4") {
			assert.isAbove(address.port, 0)
			assert.include(url, `:${address.port}`)
		}
		assert.strictEqual((yield* request(url)).status, 404)
	}).pipe(run),
)

it.effect("rejects missing and invalid ports", () =>
	Effect.gen(function* () {
		for (const input of [{}, { port: -1 }, { port: 65536 }, { port: 1.5 }]) {
			const exit = yield* Effect.exit(Schema.decodeUnknownEffect(Config)(input))
			assert.isTrue(Exit.isFailure(exit))
		}
	}),
)

it.live("fails apply with ServeError when the port is occupied", () =>
	Effect.gen(function* () {
		const { address } = yield* start
		if (address._tag !== "InetAddressV4")
			return assert.fail("Expected a TCP address")
		const fork = yield* Graft.plugin(server, { port: address.port })
		const exit = yield* Effect.exit(fork.await)
		assert.isTrue(Exit.isFailure(exit))
		if (Exit.isFailure(exit))
			assert.include(Cause.pretty(exit.cause), "ServeError")
	}).pipe(run),
)
