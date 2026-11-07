import { Effect, Result, Schema, String } from "effect"
import { assert, it } from "@effect/vitest"

import { Host } from "../src/Config"

const artifact = {
	directory: "./artifacts/release",
	identity: {
		version: 1,
		algorithm: "sha256",
		digest: String.repeat(64)("a"),
		entry: "dist/index.js",
	},
}
const managed = {
	contract: "@example/contract",
	artifact,
	target: { _tag: "Worker" },
	probes: ["health"],
}

it.effect(
	"decodes managed deployment locations without resolving or launching them",
	() =>
		Effect.gen(function* () {
			const decoded = yield* Schema.decodeUnknownEffect(Host)(managed)
			assert.deepEqual(decoded.artifact, artifact)
			assert.deepEqual(decoded.config, {})
		}),
)
for (const value of [
	{ ...managed, implementation: "./mutable.js", connect: { worker: {} } },
	{ ...managed, target: { _tag: "Runner" } },
	{ ...managed, maxInFlight: 17 },
	{
		...managed,
		artifact: {
			...artifact,
			identity: { ...artifact.identity, digest: "invalid" },
		},
		implementation: "./mutable.js",
		connect: { worker: {} },
	},
]) {
	it("rejects an unsupported or ambiguous managed deployment", () => {
		assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(Host)(value)))
	})
}
