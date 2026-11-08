import { Effect, Option, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import type { Kernel } from "@graftland/graft"

import * as Wire from "../src/internal/unitProtocol"

const member = (
	instance: string,
	parent: Option.Option<string>,
): Kernel.MemberDeclaration => ({
	instance,
	declaration: Option.isNone(parent) ? "self" : "worker",
	parent,
	realm: "tenant-a",
	target: { identity: "captured-plugin", placement: "Process", overlap: false },
	localProvides: Option.isNone(parent) ? ["private/state"] : [],
	localRequires: Option.isSome(parent)
		? [{ key: "private/state", optional: false }]
		: [],
	provides: [],
	requires: [],
	resources: [{ key: "tenant-a/cache", mode: "Shared", overlap: false }],
	colocate: [],
	placement: Option.some({ kind: "Process", security: "profile-a" }),
	overlap: false,
	probes: ["ready"],
})
it.effect(
	"round-trips identified parent/child declarations, realm inputs, local edges and resource placement without executable values (I2, I3, I4, F3)",
	() =>
		Effect.gen(function* () {
			const description: Kernel.Description = {
				artifact: "captured-plugin",
				configuration: "input-fingerprint",
				environment: "unit-environment",
				protocol: 1,
				members: [
					member("parent", Option.none()),
					member("parent/worker", Option.some("parent")),
				],
			}
			const decoded = yield* Schema.decodeEffect(
				Schema.toType(Wire.Description),
			)(description)
			const serialized = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.toCodecJson(Wire.Description)),
			)(decoded)
			const roundtrip = yield* Schema.decodeEffect(
				Schema.fromJsonString(Schema.toCodecJson(Wire.Description)),
			)(serialized)
			assert.deepEqual(roundtrip, description)
			assert.equal(roundtrip.members.length, 2)
		}),
)
