/** Prepares deployment data through disposable kernel-controlled inspection units. */
import { Array, Cause, Effect, HashMap, Option, Schema } from "effect"

import type { Kernel } from "@graftland/graft"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import type { Descriptor } from "./ModuleResolver"

export class PreparationFailed extends Schema.TaggedError<
	PreparationFailed,
	{ readonly brand: unique symbol }
>()("PreparationFailed", {
	reason: Schema.Literals([
		"InvalidInput",
		"InvalidModule",
		"UnregisteredIntercept",
		"InspectionFailed",
	]),
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

export interface EnvironmentModule {
	readonly module: Descriptor
	readonly options: unknown
}
export interface Patch {
	readonly key: string
	readonly patch: unknown
}
export interface Input {
	readonly instance: string
	readonly module: Descriptor
	readonly input: unknown
	readonly placement?: "Worker" | "Process"
	readonly environment?: ReadonlyArray<EnvironmentModule>
	/** Inherited patches precede descendant patches. */
	readonly intercept?: ReadonlyArray<Patch>
}
export interface Options {
	readonly control: Control.Address
	readonly budget?: Partial<Kernel.Budget>
	/** Immutable module identities, keyed by registered reference name. */
	readonly intercepts?: HashMap.HashMap<string, Descriptor>
}
export interface Prepared {
	readonly target: Kernel.Target
	readonly description: Kernel.Description
	readonly preparation: string
}

const encoded = (input: unknown) =>
	Schema.decodeUnknownEffect(Schema.Json)(input).pipe(
		Effect.catchCause((cause) =>
			PreparationFailed.make({ reason: "InvalidInput", cause }),
		),
	)
const environmentModule = Effect.fnUntraced(function* (
	entry: EnvironmentModule,
): Effect.fn.Return<Kernel.ConfigurationModule, PreparationFailed> {
	if (entry.module.kind !== "Environment")
		return yield* PreparationFailed.make({
			reason: "InvalidModule",
			cause: Cause.fail("Expected an environment Layer descriptor"),
		})
	const options = yield* encoded(entry.options)
	return {
		artifact: entry.module.artifact,
		export: entry.module.export,
		options,
	}
})

const target = Effect.fnUntraced(function* (input: Input, options: Options) {
	if (input.module.kind !== "Plugin")
		return yield* PreparationFailed.make({
			reason: "InvalidModule",
			cause: Cause.fail("Expected a plugin descriptor"),
		})
	const configuration = yield* encoded(input.input)
	const patches = yield* Effect.forEach(
		input.intercept ?? [],
		Effect.fnUntraced(function* (entry) {
			const module = HashMap.get(
				options.intercepts ?? HashMap.empty(),
				entry.key,
			)
			if (Option.isNone(module))
				return yield* PreparationFailed.make({
					reason: "UnregisteredIntercept",
					cause: Cause.fail({ key: entry.key }),
				})
			return { module: module.value, options: entry.patch }
		}),
	)
	const environment = yield* Effect.forEach(
		Array.appendAll(input.environment ?? [], patches),
		environmentModule,
	)
	return Units.target({
		artifact: input.module.artifact,
		moduleSuffix: input.module.suffix,
		input: configuration,
		placement: input.placement ?? "Worker",
		...(environment.length === 0 ? {} : { environment }),
	})
})

export const make = Effect.fnUntraced(function* (options: Options) {
	const control = yield* Control.connect(options.control)
	return {
		inspect: Effect.fnUntraced(function* (
			input: Input,
		): Effect.fn.Return<Prepared, PreparationFailed> {
			const deployment = yield* target(input, options)
			const status = yield* control
				.inspect({
					instance: input.instance,
					target: deployment,
					...(options.budget === undefined ? {} : { budget: options.budget }),
				})
				.pipe(
					Effect.catchCause((cause) =>
						PreparationFailed.make({ reason: "InspectionFailed", cause }),
					),
				)
			if (
				Option.isNone(status.result) ||
				status.result.value._tag !== "Described"
			)
				return yield* PreparationFailed.make({
					reason: "InspectionFailed",
					cause: status.cause,
				})
			return {
				target: deployment,
				description: status.result.value.description,
				preparation: status.id,
			}
		}),
	}
})
