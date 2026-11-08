import { Context, Effect, Option, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { assert, describe, it } from "@effect/vitest"

import { Plugin } from "@graftland/graft"

import { expectTypeOf } from "vitest"

import { Contract } from "../src/index"

class First extends Context.Service<First, {}>()(
	"@graftland/plugin-remote/test/contract.test/First",
) {}
class Second extends Context.Service<Second, {}>()(
	"@graftland/plugin-remote/test/contract.test/Second",
) {}

const service = (key: Context.Key<unknown, {}>, tag: string) =>
	Contract.service(
		key,
		RpcGroup.make(Contract.operation(`${key.key}/${tag}`, 1, Rpc.make(tag))),
		{
			toHandlers: () => ({ [tag]: () => Effect.void }),
			fromClient: () => ({}),
		},
	)
const options = {
	name: "tag-validation",

	config: Schema.Struct({}),
}
describe("contract endpoint validation", () => {
	it("rejects duplicate injected service keys during unit declaration checks", () => {
		const contract = Contract.make({
			...options,
			inject: [service(First, "Shared"), service(First, "Different")],
		})
		assert.equal(
			Option.getOrThrow(Contract.check(contract)).reason,
			"DuplicateService",
		)
	})
	it("rejects duplicate exported service keys during unit declaration checks", () => {
		const contract = Contract.make({
			...options,
			provides: [service(First, "Shared"), service(First, "Different")],
		})
		assert.equal(
			Option.getOrThrow(Contract.check(contract)).reason,
			"DuplicateService",
		)
	})
	it("allows matching RPC and control tags on separate service endpoints", () => {
		for (const tag of [
			"Describe",
			"Serve",
			"Ready",
			"Probe",
			"Stop",
			"Events",
			"Logs",
		]) {
			const contract = Contract.make({
				...options,
				provides: [service(First, tag), service(Second, tag)],
			})
			assert.isTrue(Option.isNone(Contract.check(contract)))
		}
	})
	it("rejects a service key repeated across directions during unit declaration checks", () => {
		const contract = Contract.make({
			...options,
			inject: [service(First, "One")],
			provides: [service(First, "Two")],
		})
		assert.equal(
			Option.getOrThrow(Contract.check(contract)).reason,
			"DuplicateService",
		)
	})
	it("allows matching tags in opposite directions", () => {
		assert.isTrue(
			Option.isNone(
				Contract.check(
					Contract.make({
						...options,
						inject: [service(First, "Shared")],
						provides: [service(Second, "Shared")],
					}),
				),
			),
		)
	})
})

it("defaults the error schema to Never without widening its type", () => {
	const contract = Contract.make(options)
	expectTypeOf(contract.error).toEqualTypeOf<typeof Schema.Never>()
	assert.strictEqual(contract.error, Schema.Never)
})
it("preserves an explicitly declared error schema", () => {
	const error = Schema.Literal("unavailable")
	const contract = Contract.make({ ...options, error })
	expectTypeOf(contract.error).toEqualTypeOf<typeof error>()
	assert.strictEqual(contract.error, error)
})

describe("operation identities", () => {
	it("preserves RPC types, schemas, tags and other annotations without mutating the input", () => {
		const original = Rpc.make("Read", {
			payload: { id: Schema.String },
			success: Schema.Int,
			error: Schema.String,
		}).annotate(First, {})
		const named = Contract.operation("@acme/items/read", 1, original)
		assert.deepEqual(
			Contract.identity(named),
			Option.some({ name: "@acme/items/read", version: 1 }),
		)
		assert.deepEqual(Contract.identity(original), Option.none())
		expectTypeOf(named).toEqualTypeOf<typeof original>()
		assert.deepEqual(
			Context.getOption(named.annotations, First),
			Context.getOption(original.annotations, First),
		)
		assert.strictEqual(named._tag, original._tag)
		assert.strictEqual(named.payloadSchema, original.payloadSchema)
		assert.strictEqual(named.successSchema, original.successSchema)
		assert.strictEqual(named.errorSchema, original.errorSchema)
		const descriptor = Contract.service(First, RpcGroup.make(named), {
			toHandlers: () => ({ Read: () => Effect.succeed(1) }),
			fromClient: () => ({}),
		})
		expectTypeOf(descriptor).toExtend<Plugin.ProvidedContract>()
		assert.deepEqual(descriptor.operations, [
			{ name: "@acme/items/read", version: 1 },
		])
		const missing = Contract.service(First, RpcGroup.make(original), {
			toHandlers: () => ({ Read: () => Effect.succeed(1) }),
			fromClient: () => ({}),
		})
		assert.equal(
			Option.getOrThrow(
				Contract.check(Contract.make({ ...options, provides: [missing] })),
			).reason,
			"MissingIdentity",
		)
		const repeated = Contract.operation("@acme/items/other", 2, named)
		assert.equal(
			Option.getOrThrow(Contract.checkOperation(repeated)).reason,
			"AlreadyDeclared",
		)
	})
	it("rejects malformed operation names and versions during unit declaration checks", () => {
		for (const name of ["", "contains whitespace", " padded "])
			assert.equal(
				Option.getOrThrow(
					Contract.checkOperation(
						Contract.operation(name, 1, Rpc.make("Read")),
					),
				).reason,
				"InvalidIdentity",
			)
		for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
			assert.equal(
				Option.getOrThrow(
					Contract.checkOperation(
						Contract.operation("@acme/items/read", version, Rpc.make("Read")),
					),
				).reason,
				"InvalidIdentity",
			)
	})
	it("rejects duplicate identities even when wire tags differ", () => {
		const group = RpcGroup.make(
			Contract.operation("@acme/items/read", 1, Rpc.make("First")),
			Contract.operation("@acme/items/read", 1, Rpc.make("Second")),
		)
		const descriptor = Contract.service(First, group, {
			toHandlers: () => ({
				First: () => Effect.void,
				Second: () => Effect.void,
			}),
			fromClient: () => ({}),
		})
		assert.equal(
			Option.getOrThrow(
				Contract.check(Contract.make({ ...options, provides: [descriptor] })),
			).reason,
			"DuplicateIdentity",
		)
	})
	it("accepts multiple versions of one operation under distinct wire tags", () => {
		const group = RpcGroup.make(
			Contract.operation("@acme/items/read", 1, Rpc.make("ReadV1")),
			Contract.operation("@acme/items/read", 2, Rpc.make("ReadV2")),
		)
		const descriptor = Contract.service(First, group, {
			toHandlers: () => ({
				ReadV1: () => Effect.void,
				ReadV2: () => Effect.void,
			}),
			fromClient: () => ({}),
		})
		assert.deepEqual(descriptor.operations, [
			{ name: "@acme/items/read", version: 1 },
			{ name: "@acme/items/read", version: 2 },
		])
	})
})

describe("operation compatibility", () => {
	const read = Plugin.OperationIdentity.make({
		name: "@acme/items/read",
		version: 1,
	})
	const readV2 = Plugin.OperationIdentity.make({
		name: "@acme/items/read",
		version: 2,
	})
	const list = Plugin.OperationIdentity.make({
		name: "@acme/items/list",
		version: 1,
	})
	it("accepts an empty requirement and additive provider operations", () => {
		assert.deepEqual(Contract.compareOperations([], []), { _tag: "Compatible" })
		assert.deepEqual(Contract.compareOperations([], [read]), {
			_tag: "Compatible",
		})
		assert.deepEqual(
			Contract.compareOperations([read], [list, readV2, { ...read }]),
			{ _tag: "Compatible" },
		)
	})
	it("requires exact names and versions and reports each missing identity once", () => {
		assert.deepEqual(
			Contract.compareOperations([read, list, { ...read }], [readV2]),
			{
				_tag: "Incompatible",
				missing: [read, list],
			},
		)
		assert.deepEqual(Contract.compareOperations([readV2], [read]), {
			_tag: "Incompatible",
			missing: [readV2],
		})
	})
	it("compares sets without changing input arrays or depending on declaration order", () => {
		const required = Object.freeze([read, list])
		const provided = Object.freeze([list, { ...read }, read])
		assert.deepEqual(Contract.compareOperations(required, provided), {
			_tag: "Compatible",
		})
		assert.deepEqual(required, [read, list])
		assert.deepEqual(provided, [list, read, read])
	})
})
