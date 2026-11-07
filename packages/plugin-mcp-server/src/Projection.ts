/** Explicit MCP views of existing contract operations. */
import {
	Array,
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	HashSet,
	Option,
	Record,
	Ref,
	Result,
	Schema,
	SchemaAST,
	Scope,
	Semaphore,
} from "effect"
import { Tool, Toolkit } from "effect/ai"
import { RpcSchema, type Rpc, type RpcMiddleware } from "effect/rpc"

import { Event, type Graft } from "@graftland/graft"
import { Contract } from "@graftland/plugin-remote"

import * as Catalog from "./Catalog"
import * as Tools from "./Tools"

/** Required MCP metadata. This annotation never participates in contract identity. */
export const Metadata = Schema.Struct({
	name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/)),
	title: Schema.NonEmptyString,
	description: Schema.NonEmptyString,
	readOnlyHint: Schema.Boolean,
	destructiveHint: Schema.Boolean,
	idempotentHint: Schema.Boolean,
	openWorldHint: Schema.Boolean,
	output: Schema.Literals(["json", "void"]),
})
export type Metadata = typeof Metadata.Type

export class Annotation extends Context.Service<Annotation, Metadata>()(
	"@graftland/plugin-mcp-server/Projection/Annotation",
) {}

export class ProjectionError extends Schema.TaggedError<
	ProjectionError,
	{ readonly brand: unique symbol }
>()("ProjectionError", {
	service: Schema.String,
	operation: Schema.String,
	reason: Schema.String,
}) {}

/** A schema whose portable codec needs no additional services. */
export type PortableSchema = Schema.Top & {
	readonly DecodingServices: never
	readonly EncodingServices: never
}

export const ToolFailure = Schema.Struct({
	kind: Schema.Literals(["business", "system"]),
	message: Schema.String,
	value: Schema.optionalKey(Schema.Json),
})
export type ToolFailure = typeof ToolFailure.Type

/** An erased, validated operation; only its captured invocation interprets the payload. */
export interface Prepared<R> {
	readonly service: string
	readonly operation: string
	readonly metadata: Metadata
	readonly tool: Tool.Any
	readonly invoke: (payload: unknown) => Effect.Effect<unknown, ToolFailure, R>
}

export interface Binding<R> {
	readonly prepare: Effect.Effect<Prepared<R>, ProjectionError>
}

const portable = (
	ast: SchemaAST.AST,
	parents: HashSet.HashSet<SchemaAST.AST> = HashSet.empty(),
): void => {
	const encoded = SchemaAST.toEncoded(ast)
	if (HashSet.has(parents, encoded))
		throw new Error(
			"Recursive payload schemas are not supported by this projection",
		)
	const next = HashSet.add(parents, encoded)
	switch (encoded._tag) {
		case "Objects":
			for (const property of encoded.propertySignatures) {
				if (typeof property.name === "symbol")
					throw new Error("Symbol payload keys cannot be projected")
				portable(property.type, next)
			}
			for (const index of encoded.indexSignatures) portable(index.type, next)
			return
		case "Arrays":
			for (const child of [...encoded.elements, ...encoded.rest])
				portable(child, next)
			return
		case "Union":
			for (const child of encoded.types) portable(child, next)
			return
		case "Suspend":
			return portable(encoded.thunk(), next)
		case "String":
		case "Number":
		case "Boolean":
		case "Null":
		case "Literal":
		case "Enum":
		case "TemplateLiteral":
		case "Never":
			return
		default:
			throw new Error(
				`Payload schema ${encoded._tag} has no supported MCP projection`,
			)
	}
}

/** Binds a declared RPC to the injected service, including a managed fork-owned facade. */
export const operation = <
	I,
	S,
	Tag extends string,
	P extends PortableSchema,
	A extends PortableSchema,
	E extends PortableSchema,
	M extends RpcMiddleware.AnyService,
	Requires,
	Failure,
	R,
>(
	key: Context.Key<I, S>,
	rpc: Rpc.Rpc<Tag, P, A, E, M, Requires>,
	invoke: (
		service: S,
		payload: P["Type"],
	) => Effect.Effect<A["Type"], Failure, R>,
): Binding<I | R> => ({
	prepare: Effect.gen(function* () {
		const identity = Contract.identity(rpc)
		const id = Option.isSome(identity)
			? `${identity.value.name}@${identity.value.version}`
			: rpc._tag
		const reject = (reason: string) =>
			ProjectionError.make({ service: key.key, operation: id, reason })
		if (Option.isNone(identity))
			return yield* reject(
				"Declare a contract operation identity before projecting it",
			)
		const annotation = Context.getOption(rpc.annotations, Annotation)
		if (Option.isNone(annotation))
			return yield* reject(
				"Declare the tool name, title, description, four hints and output policy",
			)
		const decoded = yield* Schema.decodeEffect(Metadata)(annotation.value).pipe(
			Effect.mapError((error) => reject(error.message)),
		)
		const metadata = Object.freeze({ ...decoded })
		if (RpcSchema.isStreamSchema(rpc.successSchema))
			return yield* reject(
				"Streaming operations are not supported by this projection",
			)
		if (rpc.middlewares.size > 0)
			return yield* reject(
				"RPC middleware is not supported by this projection; bind a service without RPC middleware",
			)
		const parameters = yield* Effect.try({
			try: () => {
				const codec = Schema.toCodecJson(rpc.payloadSchema)
				portable(codec.ast)
				const document = Schema.toJsonSchemaDocument(codec, {
					referencePolicy: () => undefined,
				})
				if (document.schema["type"] !== "object")
					throw new Error("MCP tool payloads must project to an object schema")
				return codec
			},
			catch: (error) => reject(String(error)),
		})
		const tool = Tool.make(metadata.name, {
			description: metadata.description,
			parameters,
			success:
				metadata.output === "json"
					? Schema.Struct({ value: Schema.Json })
					: Schema.Void,
			failure: ToolFailure,
			failureMode: "return",
		})
			.annotate(Tool.Title, metadata.title)
			.annotate(Tool.Readonly, metadata.readOnlyHint)
			.annotate(Tool.Destructive, metadata.destructiveHint)
			.annotate(Tool.Idempotent, metadata.idempotentHint)
			.annotate(Tool.OpenWorld, metadata.openWorldHint)
		return {
			service: key.key,
			operation: id,
			metadata,
			tool,
			invoke: (payload: unknown) =>
				Effect.gen(function* () {
					const service = yield* key
					// The toolkit decodes this payload with the same codec before dispatch.
					const exit = yield* Effect.exit(
						Effect.suspend(() => invoke(service, payload as P["Type"])),
					)
					if (Exit.isFailure(exit)) {
						if (Cause.hasInterruptsOnly(exit.cause))
							return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
						yield* Effect.logError(
							"Projected contract call failed",
							exit.cause,
						).pipe(Effect.annotateLogs({ service: key.key, operation: id }))
						const error = Cause.findError(exit.cause)
						if (
							!Cause.hasDies(exit.cause) &&
							Result.isSuccess(error) &&
							!(
								typeof error.success === "object" &&
								error.success !== null &&
								"_tag" in error.success &&
								[
									"RpcClientError",
									"ContractFailure",
									"UndeclaredFailure",
								].includes(String(error.success._tag))
							)
						) {
							const encoded = yield* Effect.exit(
								Effect.suspend(() =>
									Schema.encodeUnknownEffect(
										Schema.toCodecJson(rpc.errorSchema),
									)(error.success),
								),
							)
							if (Exit.isSuccess(encoded))
								return yield* Effect.fail<ToolFailure>({
									kind: "business",
									message: "The operation returned a declared error",
									value: encoded.value,
								})
							if (Cause.hasInterruptsOnly(encoded.cause))
								return yield* Effect.failCause(
									encoded.cause as Cause.Cause<never>,
								)
							yield* Effect.logError(
								"Projected business error encoding failed",
								encoded.cause,
							)
						}
						return yield* Effect.fail<ToolFailure>({
							kind: "system",
							message: "The operation could not be completed",
						})
					}
					if (metadata.output === "void") return undefined
					return yield* Effect.suspend(() =>
						Schema.encodeUnknownEffect(Schema.toCodecJson(rpc.successSchema))(
							exit.value,
						),
					).pipe(
						Effect.map((value) => ({ value })),
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.failCause(cause as Cause.Cause<never>)
								: Effect.logError(
										"Projected output encoding failed",
										cause,
									).pipe(
										Effect.andThen(
											Effect.fail<ToolFailure>({
												kind: "system",
												message: "The operation output could not be encoded",
											}),
										),
									),
						),
					)
				}),
		}
	}),
})

export interface Description {
	readonly service: string
	readonly operation: string
	readonly metadata: Metadata
}
export interface Change {
	readonly revision: number
	readonly before: ReadonlyArray<Description>
	readonly after: ReadonlyArray<Description>
}
/** Applications may persist these events for later review. No approval is performed here. */
export const Changed = Event.make<[change: Change]>(
	"@graftland/plugin-mcp-server/Projection/Changed",
)

export interface Controller<R> {
	readonly update: (
		bindings: ReadonlyArray<Binding<R>>,
	) => Effect.Effect<void, ProjectionError>
	readonly history: Effect.Effect<ReadonlyArray<Change>>
	/** Validate before running the action; concurrent actions fail without queuing. Admitted work belongs to the contributor. */
	readonly updateAfter: <A, E, R2>(
		action: Effect.Effect<A, E, R2>,
		bindings: ReadonlyArray<Binding<R>>,
		accepted: (value: A) => boolean,
	) => Effect.Effect<A, E | ProjectionError, R2>
}

const prepare = <R>(bindings: ReadonlyArray<Binding<R>>) =>
	Effect.gen(function* () {
		const prepared = yield* Effect.forEach(
			bindings,
			(binding) => binding.prepare,
		)
		yield* Effect.forEach(prepared, (item, index) => {
			const preceding = prepared.slice(0, index)
			return Array.some(
				preceding,
				(other) =>
					other.metadata.name === item.metadata.name ||
					(other.service === item.service &&
						other.operation === item.operation),
			)
				? Effect.fail(
						ProjectionError.make({
							service: item.service,
							operation: item.operation,
							reason:
								"Tool names and service/operation bindings must be unique within a projection",
						}),
					)
				: Effect.void
		})
		return prepared
	})

/** Registers one dynamic contributor; revisions share its call owner and do not interrupt old calls. */
export const offer = <R>(
	bindings: ReadonlyArray<Binding<R>>,
): Effect.Effect<
	Controller<R>,
	ProjectionError,
	Graft.Graft | Scope.Scope | Exclude<R, Catalog.RequestServices>
> =>
	Effect.gen(function* () {
		const initial = yield* prepare(bindings)
		const scope = yield* Effect.scope
		const environment = yield* Effect.context<Graft.Graft>()
		const mutex = yield* Semaphore.make(1)
		const invoke = yield* Catalog.own((item: Prepared<R>, payload: unknown) =>
			item.invoke(payload),
		)
		const registration = (items: ReadonlyArray<Prepared<R>>) =>
			Effect.gen(function* () {
				const toolkit = Toolkit.make(...Array.map(items, (item) => item.tool))
				const handlers = yield* toolkit.toHandlers(
					Record.fromEntries(
						Array.map(
							items,
							(item) =>
								[
									item.metadata.name,
									(payload: unknown) => invoke(item, payload),
								] as const,
						),
					) as Toolkit.HandlersFrom<Record<string, Tool.Any>>,
				)
				return { toolkit, handlers } as Tools.Registration
			})
		const first = yield* registration(initial)
		const descriptions = (
			items: ReadonlyArray<Prepared<R>>,
		): ReadonlyArray<Description> =>
			Array.map(items, ({ service, operation, metadata }) => ({
				service,
				operation,
				metadata,
			}))
		const initialChange: Change = {
			revision: 1,
			before: [],
			after: descriptions(initial),
		}
		const current = yield* Ref.make<{
			readonly registration: Tools.Registration
			readonly history: ReadonlyArray<Change>
		}>({ registration: first, history: [initialChange] })
		yield* Event.on(Catalog.Offered, () =>
			Ref.get(current).pipe(
				Effect.map((state) => [{ kind: Tools.kind, item: state.registration }]),
			),
		)
		yield* Effect.addFinalizer(() => Event.emit(Catalog.Changed))
		yield* Event.emit(Catalog.Changed)
		yield* Event.emit(Changed, initialChange)
		const publish = (items: ReadonlyArray<Prepared<R>>) =>
			Effect.gen(function* () {
				const next = yield* registration(items)
				const change = yield* Ref.modify(current, (state) => {
					const previous = state.history.at(-1)!
					const change: Change = {
						revision: previous.revision + 1,
						before: previous.after,
						after: descriptions(items),
					}
					return [
						change,
						{
							registration: next,
							history: [...state.history, change].slice(-32),
						},
					] as const
				})
				yield* Event.emit(Catalog.Changed)
				yield* Event.emit(Changed, change)
			}).pipe(Effect.provide(environment))
		const updateAfter: Controller<R>["updateAfter"] = (
			action,
			next,
			accepted,
		) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const items = yield* restore(prepare(next))
					const work = mutex
						.withPermitsIfAvailable(1)(
							Effect.gen(function* () {
								const result = yield* action
								if (accepted(result)) yield* publish(items)
								return result
							}),
						)
						.pipe(
							Effect.flatMap((result) =>
								Effect.fromOption(result).pipe(
									Effect.mapError(() =>
										ProjectionError.make({
											service: "projection",
											operation: "update",
											reason:
												"Another view update or deployment action is running; retry after it completes",
										}),
									),
								),
							),
						)
					const fiber = yield* Effect.forkIn(
						Effect.interruptible(work).pipe(
							Effect.tapCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.void
									: Effect.logError(
											"Projected deployment action failed",
											cause,
										),
							),
						),
						scope,
					)
					return yield* restore(Fiber.join(fiber))
				}),
			)
		return {
			update: (next) => updateAfter(Effect.void, next, () => true),
			updateAfter,
			history: Ref.get(current).pipe(Effect.map((state) => state.history)),
		}
	})
