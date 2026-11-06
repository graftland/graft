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
			assert.equal(candidate.deployment, options)
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
