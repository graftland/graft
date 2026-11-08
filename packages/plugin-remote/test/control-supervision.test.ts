import { Array, Effect, Option, Schema } from "effect"
import { assert, it } from "@effect/vitest"

import type * as Kernel from "@graftland/graft/Kernel"

import * as Wire from "../src/internal/controlProtocol"

it.effect(
	"carries every supervisor down reason and absence through the control codec",
	() =>
		Effect.gen(function* () {
			const reasons: ReadonlyArray<Option.Option<Kernel.InstanceDownReason>> = [
				Option.some("Revoked"),
				Option.some("Escalated"),
				Option.some("WaitingForDependency"),
				Option.some("RestartPending"),
				Option.none(),
			]
			const frame: Wire.Outgoing = {
				_tag: "Reply",
				id: "supervision-query",
				result: {
					_tag: "Supervision",
					value: Array.map(reasons, (reason, i) => ({
						instance: `instance-${i}`,
						attempts: [10],
						escalated: Option.contains(reason, "Escalated"),
						reason,
					})),
				},
			}
			const encoded = yield* Wire.encodeResponse(frame)
			const decoded = yield* Wire.decodeResponse(encoded)
			assert.deepEqual(decoded, frame)
		}),
)

it.effect(
	"accepts encodable backoff parameters and rejects invalid durations and factors",
	() =>
		Effect.gen(function* () {
			const decode = Schema.decodeUnknownEffect(Wire.Deployment)
			const deployment = {
				authority: "backoff-codec",
				maxUnits: 2,
				instances: [],
				supervision: { backoff: { initial: 100, factor: 2, max: 5000 } },
			}
			const decoded = yield* decode(deployment)
			assert.deepEqual(decoded, deployment)
			for (const backoff of [
				{ initial: -1, factor: 2, max: 5000 },
				{ initial: 100, factor: 0.5, max: 5000 },
				{ initial: 100, factor: 2, max: -1 },
				{ initial: 100, factor: Infinity, max: 5000 },
			]) {
				const rejected = yield* decode({
					...deployment,
					supervision: { backoff },
				}).pipe(Effect.result)
				assert.equal(rejected._tag, "Failure")
			}
		}),
)
