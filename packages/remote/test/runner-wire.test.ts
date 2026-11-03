import { assert, describe, it } from "@effect/vitest"
import { Option, Schema, Result } from "effect"
import { defaults } from "../src/internal/runner/model"
import { Session } from "../src/internal/runner/Wire"

describe("runner request boundary", () => {
	it("validates Open identifiers, generations, lease and limits before dispatch", () => {
		const open = Option.getOrThrow(
			Option.fromUndefinedOr(Session.requests.get("Open")),
		)
		const decode = Schema.decodeUnknownResult(open.payloadSchema)
		const valid = {
			instance: "worker",
			requestId: "request",
			expectedGeneration: 1,
			leaseMillis: 10000,
			limits: defaults,
		}
		assert.isTrue(Result.isSuccess(decode(valid)))
		for (const fields of [
			{ instance: "" },
			{ requestId: "" },
			{ expectedGeneration: 0 },
			{ expectedGeneration: 1.5 },
			{ leaseMillis: 0 },
			{ leaseMillis: Infinity },
			{ limits: { ...defaults, data: 0 } },
			{ limits: { ...defaults, control: 1.5 } },
		])
			assert.isTrue(Result.isFailure(decode({ ...valid, ...fields })))
	})
})
