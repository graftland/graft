import { Option, Result, Schema } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { defaults, OpenRecord } from "../src/internal/runner/model"
import { Session } from "../src/internal/runner/Wire"

describe("runner request boundary", () => {
	it("keeps the termination notice extension compatible with v1 Open replies", () => {
		const { terminationNotice: _notice, ...fields } = OpenRecord.fields
		const legacy = Schema.Struct(fields)
		const record = {
			version: 1,
			phase: "Open",
			handle: {
				key: { identity: "test", instance: "worker" },
				token: "token",
				generation: 1,
			},
			requestId: "request",
			leaseMillis: 15000,
			limits: defaults,
		}
		const before = Result.getOrThrow(
			Schema.decodeUnknownResult(OpenRecord)(record),
		)
		assert.isUndefined(before.terminationNotice)
		const extended = Result.getOrThrow(
			Schema.decodeUnknownResult(OpenRecord)({
				...record,
				terminationNotice: true,
			}),
		)
		assert.isTrue(extended.terminationNotice)
		assert.deepEqual(
			Result.getOrThrow(Schema.decodeResult(legacy)(extended)),
			record,
		)
	})

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
