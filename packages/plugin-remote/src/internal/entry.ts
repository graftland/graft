import { Cause, Effect, Option, Path, String } from "effect"

import { ConfigDirectory, Entry, ModuleResolver } from "@graftland/loader"

import * as Contract from "../Contract"
import { RemoteEntryError as EntryError } from "../Errors"
import type * as Configuration from "./entryConfig"
import * as Importer from "./importer"

export const boundary = Effect.fnUntraced(function* (field: string) {
	const entry = yield* Entry.CurrentId
	const directory = yield* ConfigDirectory
	return (cause: Cause.Cause<unknown>) =>
		Effect.fail(EntryError.make({ entry, directory, field, cause }))
})
export const resolve = Effect.fnUntraced(function* (
	reference: Configuration.Reference,
	field: string,
) {
	const existing = yield* Effect.serviceOption(ModuleResolver.ModuleResolver)
	const path = yield* Path.Path
	const source = yield* ConfigDirectory
	const directory = path.resolve(Option.getOrElse(source, () => "."))
	const resolver = yield* Option.match(existing, {
		onSome: Effect.succeed,
		onNone: Effect.fnUntraced(function* () {
			const importer = yield* Importer.make(directory)
			return yield* ModuleResolver.make({
				base: directory,
				importer: (specifier) =>
					String.startsWith("@graftland/plugin-remote/")(specifier)
						? import(specifier)
						: importer(specifier),
			})
		}),
	})
	const fail = yield* boundary(field)
	const plugin = yield* resolver
		.resolve(reference.name)
		.pipe(Effect.catchCause(fail))
	return { plugin, config: reference.config }
})
export const loadContract = Effect.fnUntraced(function* (specifier: string) {
	const resolver = yield* ModuleResolver.ModuleResolver
	const fail = yield* boundary("contract")
	return yield* resolver.importModule(specifier).pipe(
		Effect.flatMap((module) =>
			Effect.fromOption(Contract.fromModule(module), () =>
				ModuleResolver.ModuleInvalid.make({
					specifier,
					cause: "Expected a default or named remote contract",
				}),
			),
		),
		Effect.catchCause(fail),
	)
})
