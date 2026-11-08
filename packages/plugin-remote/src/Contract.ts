import {
	Array,
	Option,
	Predicate,
	Schema,
	type Context,
	type Effect,
	type Scope,
} from "effect"
import type { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc"

import type { Graft, Plugin } from "@graftland/graft"

import * as Operations from "./internal/operations"

export { service } from "./internal/services"
export {
	operation,
	identity,
	problem as checkOperation,
	type OperationProblem,
} from "./internal/operations"
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
	/** Whether every declared operation is unary. */
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

/** Pure declarations. The unit validates them before activation. */
export function make<S extends ConfigSchema, E extends ErrorSchema>(
	options: Options<S, E> & { readonly error: E },
): Contract<S, E>
export function make<S extends ConfigSchema>(
	options: Options<S, typeof Schema.Never>,
): Contract<S>
export function make<S extends ConfigSchema, E extends ErrorSchema>(
	options: Options<S, E>,
): Contract<S, E | typeof Schema.Never> {
	return {
		...options,
		error: options.error ?? Schema.Never,
		inject: Array.copy(options.inject ?? []),
		provides: Array.copy(options.provides ?? []),
		[TypeId]: TypeId,
	}
}

export interface ContractProblem {
	readonly reason:
		| Operations.OperationProblem["reason"]
		| "DuplicateService"
		| "UnsupportedCallShape"
	readonly service: string
	readonly tag?: string
}
/** Fixed metadata validation, performed by Describe before activation. It executes no schema transforms. */
export const check = (
	contract: RunnerContract,
): Option.Option<ContractProblem> => {
	const services = [...contract.inject, ...contract.provides]
	const keys = Array.map(services, (s) => s.key.key)
	if (Array.dedupe(keys).length !== keys.length)
		return Option.some({ reason: "DuplicateService", service: "" })
	return Array.reduce(
		services,
		Option.none<ContractProblem>(),
		(found, service) => {
			if (Option.isSome(found)) return found
			if (!service.unary)
				return Option.some({
					reason: "UnsupportedCallShape",
					service: service.key.key,
				})
			return Option.map(Operations.check(service.group), (problem) => ({
				...problem,
				service: service.key.key,
			}))
		},
	)
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
