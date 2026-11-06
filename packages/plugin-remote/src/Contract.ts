import {
	Array,
	Predicate,
	Schema,
	type Context,
	type Effect,
	type Scope,
} from "effect"
import type { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc"

import type { Graft, Plugin, Transition } from "@graftland/graft"

import * as Control from "./internal/control"

export { service } from "./internal/services"
export { operation } from "./internal/operations"
export { compareOperations } from "@graftland/graft/Plugin"
export type { OperationComparison } from "@graftland/graft/Plugin"

/** Brands a remote contract descriptor. */
export const TypeId = "~@graftland/plugin-remote/Contract"

/** RPC types stay inside the descriptor; Graft supplies its dynamic activation context. */
export interface Service<R = never, ClientR = never>
	extends Plugin.ProvidedContract {
	readonly key: Context.Key<unknown, unknown>
	readonly group: Pick<RpcGroup.RpcGroup<Rpc.Any>, "requests">
	readonly serve: (port: {
		readonly serverProtocol: (endpoint: string) => RpcServer.Protocol["Service"]
	}) => Effect.Effect<never, never, R>
	/** Private clients and a fork-owned facade for unary transitions. */
	readonly facade: Transition.Facade
	readonly unary: boolean
	readonly clients: (port: {
		readonly clientProtocol: (endpoint: string) => RpcClient.Protocol["Service"]
	}) => Effect.Effect<Context.Context<never>, never, Scope.Scope | ClientR>
	readonly publish: (port: {
		readonly clientProtocol: (endpoint: string) => RpcClient.Protocol["Service"]
	}) => Effect.Effect<
		void,
		Graft.ServiceConflict,
		Graft.Graft | Scope.Scope | ClientR
	>
}

/** A self-contained configuration schema that encodes as JSON. */
export type ConfigSchema = Schema.Top & {
	readonly Encoded: Schema.Json
	readonly DecodingServices: never
	readonly EncodingServices: never
}
/** A self-contained schema for declared failures. */
export type ErrorSchema = Schema.Top & {
	readonly DecodingServices: never
	readonly EncodingServices: never
}

/** The shared configuration and service declarations for one remote plugin. */
export interface Contract<
	S extends ConfigSchema,
	E extends ErrorSchema = typeof Schema.Never,
> {
	readonly name: string
	readonly config: S
	readonly error: E
	readonly inject: ReadonlyArray<Service>
	readonly provides: ReadonlyArray<Service>
	readonly [TypeId]: typeof TypeId
}
/** Configuration accepted by make; omitted errors default to Never. */
export interface Options<S extends ConfigSchema, E extends ErrorSchema> {
	readonly name: string
	readonly config: S
	readonly error?: E
	readonly inject?: ReadonlyArray<Service>
	readonly provides?: ReadonlyArray<Service>
}

/** An undeclared failure still crosses the boundary, with its diagnostic value. */
export class UndeclaredFailure extends Schema.TaggedError<
	UndeclaredFailure,
	{ readonly brand: unique symbol }
>()("UndeclaredFailure", { original: Schema.Defect({ includeStack: true }) }) {}

/** Pure metadata shared by the host and the executable runner bootstrap. */
export function make<S extends ConfigSchema, E extends ErrorSchema>(
	options: Options<S, E> & { readonly error: E },
): Contract<S, E>
export function make<S extends ConfigSchema>(
	options: Options<S, typeof Schema.Never>,
): Contract<S>
export function make<S extends ConfigSchema, E extends ErrorSchema>(
	options: Options<S, E>,
): Contract<S, E | typeof Schema.Never> {
	// Keys are runtime strings; tuple types cannot distinguish independently created keys.
	const keys = Array.map(
		[...(options.inject ?? []), ...(options.provides ?? [])],
		(service) => service.key.key,
	)
	if (
		Array.dedupe(keys).length !== keys.length ||
		keys.includes(Control.endpoint)
	)
		throw new Error(
			"Service keys must be unique within a remote contract and must not use the control endpoint",
		)

	return {
		...options,
		error: options.error ?? Schema.Never,
		inject: options.inject ?? [],
		provides: options.provides ?? [],
		[TypeId]: TypeId,
	}
}

/** A contract whose schemas are discovered through a dynamic import. */
export type RunnerContract = Contract<
	Schema.Codec<unknown, Schema.Json>,
	Schema.Codec<unknown>
>

export const isContract = (value: unknown): value is RunnerContract =>
	Predicate.hasProperty(value, TypeId) && value[TypeId] === TypeId

/** A contract module exports either default or a named contract. */
export const fromModule = (module: unknown) =>
	Array.findFirst(
		[
			Predicate.hasProperty(module, "default") ? module.default : undefined,
			Predicate.hasProperty(module, "contract") ? module.contract : undefined,
		],
		isContract,
	)
