import { Effect, FileSystem, Schema, String } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { application, runHost } from "./application"

const prepare = Effect.fnUntraced(function* (
	id: string,
	connect: Schema.Json,
	config: (directory: string) => Schema.Json,
) {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	yield* application(directory)
	const module = new URL(
		"../.cache/integration/services-contract.js",
		import.meta.url,
	).href
	const quoted = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.String),
	)(module)
	yield* fs.writeFileString(
		directory + "/contract.mjs",
		`export { contract } from ${quoted};\n`,
	)
	const yaml = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([
		{
			id,
			name: "remote",
			config: {
				contract: "./contract.mjs",
				implementation: new URL("services-plugin.js", module).href,
				connect,
				config: config(directory),
			},
		},
	])
	yield* fs.writeFileString(directory + "/host.yml", yaml)
	return { fs, directory }
})
describe("remote YAML entry", () => {
	for (const connect of [{ local: {} }, { worker: { execArgv: [] } }]) {
		it.live(
			`loads ${"local" in connect ? "local" : "worker"} without capability entries`,
			() =>
				Effect.gen(function* () {
					const { fs, directory } = yield* prepare(
						"direct",
						connect,
						(directory) => ({ directory, fail: false }),
					)
					const result = yield* runHost(directory)
					assert.equal(result.code, 0, result.stderr)
					const reply = yield* Schema.decodeEffect(
						Schema.fromJsonString(
							Schema.Struct({
								value: Schema.Finite,
								generation: Schema.Finite,
								pid: Schema.Finite,
							}),
						),
					)(String.trim(result.stdout))
					assert.equal(reply.value, 41)
					assert.equal(reply.generation, 1)
					const finalized = yield* fs.exists(
						directory + "/finalized-" + reply.pid,
					)
					assert.isTrue(finalized)
				}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		)
	}
	it.live(
		"reports the entry and field of an invalid business configuration",
		() =>
			Effect.gen(function* () {
				const { directory } = yield* prepare("broken", { local: {} }, () => ({
					directory: 42,
				}))
				const result = yield* runHost(directory)
				assert.notEqual(result.code, 0)
				assert.include(result.stderr, "Remote entry broken failed at config")
				assert.include(result.stderr, "directory")
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
