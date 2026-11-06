import { Array, Cause, Context, Effect, Exit, FileSystem, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Manifest } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Conformance from "../src/Conformance"
import {
	A,
	B,
	contract,
	serviceA,
	serviceB,
} from "./fixtures/conformance-contract"

const platform = Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto)
const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const root = yield* fs.makeTempDirectoryScoped({
		directory: new URL("../.cache", import.meta.url).pathname,
		prefix: "conformance-",
	})
	const source = root + "/source"
	yield* fs.copy(
		new URL("../.cache/integration", import.meta.url).pathname,
		source,
	)
	yield* fs.writeFileString(source + "/package.json", '{"type":"module"}')
	const artifact = yield* Artifact.capture({
		directory: source,
		entry: "conformance-plugin.js",
		store: root + "/store",
	})
	const contractModule = new URL(
		"../.cache/integration/conformance-contract.js",
		import.meta.url,
	).href
	return { artifact, contractModule }
})
const operation = "shared/read@1"
const request = (service: string, mode = "ok"): Conformance.Request => ({
	service,
	operation,
	payload: { mode },
})
const entry: Manifest.Entry = {
	implementation: "conformance-plugin.js",
	contracts: [],
	requirements: {
		placements: ["Worker", "Local"],
		filesystem: false,
		nativeModules: false,
	},
	probes: [],
	services: {
		required: [],
		optional: [],
		implements: [
			{ key: A.key, operations: [operation] },
			{ key: B.key, operations: [operation] },
		],
	},
	operations: [],
}
const suite = (cancelService: string): Conformance.Suite => ({
	entry,
	examples: Array.map([A.key, B.key], (service) => ({
		...request(service),
		expected: { _tag: "Success", value: "ok" },
	})),
	cancellation: {
		request: request(cancelService, "wait"),
		started: request(cancelService, "started"),
		released: request(cancelService, "released"),
	},
})
for (const target of [
	{ _tag: "Worker", execArgv: [] },
	{ _tag: "Local" },
] as const) {
	it.live(
		`${target._tag} conformance cannot hide a defective second service behind a shared operation`,
		() =>
			Effect.gen(function* () {
				const options = yield* setup
				const session = yield* Conformance.direct(contract, {
					...options,
					target,
					input: { broken: true },
				})
				assert.deepEqual(session.operations, [
					{ service: A.key, operation },
					{ service: B.key, operation },
				])
				const first = yield* session.call(request(A.key))
				assert.deepEqual(first, Exit.succeed("ok"))
				const missing = yield* Effect.flip(
					Conformance.run(session, {
						...suite(A.key),
						examples: [
							{ ...request(A.key), expected: { _tag: "Success", value: "ok" } },
						],
					}),
				)
				assert.include(
					Cause.pretty(Cause.fail(missing)),
					`Missing conformance case for service ${B.key}, operation ${operation}`,
				)
				const failed = yield* Effect.flip(
					Conformance.run(session, suite(A.key)),
				)
				const cause = Cause.pretty(Cause.fail(failed))
				assert.include(
					cause,
					`Expected success for service ${B.key}, operation ${operation}`,
				)
				assert.include(cause, "Service B failed")
				for (const effect of [
					session.call(request("review/Unknown")),
					session.roundTrip(request("review/Unknown"), "ok", "success"),
					session.equal(request("review/Unknown"), "ok", "ok", "success"),
				]) {
					const failure = yield* Effect.flip(effect)
					assert.include(failure.message, "Unknown service review/Unknown")
					assert.include(failure.message, operation)
				}
			}).pipe(Effect.scoped, Effect.provide(platform)),
	)
	it.live(
		`${target._tag} conformance covers both services and cancels the addressed second service`,
		() =>
			Effect.gen(function* () {
				const options = yield* setup
				const session = yield* Conformance.direct(contract, {
					...options,
					target,
					input: { broken: false },
				})
				yield* Conformance.run(session, suite(B.key))
			}).pipe(Effect.scoped, Effect.provide(platform)),
	)
	it.live(
		`${target._tag} declaration agreement includes service keys even when operation identities match`,
		() =>
			Effect.gen(function* () {
				const options = yield* setup
				const expected = {
					...contract,
					provides: [
						serviceA,
						{
							...serviceB,
							key: Context.Service<unknown, unknown>("review/Wrong"),
						},
					],
				}
				const failure = yield* Effect.flip(
					Conformance.direct(expected, {
						...options,
						target,
						input: { broken: false },
					}),
				)
				const cause = Cause.pretty(Cause.fail(failure))
				assert.include(cause, "declarations disagree")
				assert.include(cause, "review/Wrong")
				assert.include(cause, B.key)
				assert.include(cause, operation)
			}).pipe(Effect.scoped, Effect.provide(platform)),
	)
}
