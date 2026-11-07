import { Effect, String } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as Remote from "../src/index"

it.effect(
	"describes a captured artifact without verifying or launching it",
	() =>
		Effect.gen(function* () {
			const options: Remote.CandidateOptions = {
				artifact: {
					directory: "/unavailable/artifact",
					identity: {
						version: 1,
						algorithm: "sha256",
						digest: String.repeat(64)("a"),
						entry: "index.js",
					},
				},
				contractModule: "unavailable-contract",
				target: { _tag: "Worker" },
				input: {},
			}
			const candidate = Remote.candidate(options)
			assert.equal(candidate.driver, "@graftland/plugin-remote/direct")
			assert.deepEqual(candidate.deployment, options)
			const fork = yield* Graft.plugin(
				Plugin.make({ name: "ordinary", apply: () => Effect.void }),
			)
			yield* fork.await
			const result = yield* Graft.transition({ target: fork.id, candidate })
			assert.deepEqual(result, {
				_tag: "Aborted",
				reason: "UnsupportedTarget",
				phase: "Admission",
				evidence: [],
			})
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it("snapshots and freezes nested candidate input, artifact and target options", () => {
	const input = { nested: { value: "original" }, items: ["original"] }
	const execArgv = ["--no-warnings"]
	const options = {
		artifact: {
			directory: "/captured",
			identity: {
				version: 1 as const,
				algorithm: "sha256" as const,
				digest: String.repeat(64)("a"),
				entry: "index.js",
			},
		},
		contractModule: "contract",
		target: { _tag: "Worker" as const, execArgv },
		input,
	}
	const value = Remote.candidate(options)
	input.nested.value = "mutated"
	input.items.push("mutated")
	execArgv.push("--inspect")
	options.artifact.directory = "/mutated"
	const pinned = value.deployment as Remote.CandidateOptions
	assert.deepEqual(pinned.input, {
		nested: { value: "original" },
		items: ["original"],
	})
	assert.deepEqual(pinned.target, {
		_tag: "Worker",
		execArgv: ["--no-warnings"],
	})
	assert.equal(pinned.artifact.directory, "/captured")
	assert.isTrue(Object.isFrozen(pinned))
	assert.isTrue(Object.isFrozen(pinned.input))
	assert.isTrue(Object.isFrozen(pinned.target))
})
