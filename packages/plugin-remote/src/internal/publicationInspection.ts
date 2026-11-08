import { fileURLToPath, pathToFileURL } from "node:url"

import { Array, Cause, Effect, FileSystem, Path, String } from "effect"

import { Manifest, Plugin } from "@graftland/graft"

import * as Contract from "../Contract"
import { declarations, PublicationError, type EntryInput } from "../Publication"
import { packageAt, resolve } from "./publicationPackage"

const failure = (message: string, cause?: Cause.Cause<unknown>) =>
	PublicationError.make({ message, ...(cause === undefined ? {} : { cause }) })
const importModule = (url: string) =>
	Effect.tryPromise({
		try: () => import(url),
		catch: (cause) => failure(`Cannot import ${url}`, Cause.die(cause)),
	}).pipe(Effect.uninterruptible)
/** Imports built declarations and returns metadata without activating the plugin. */
export const inspect = Effect.fn("Publication.inspectEntry")(function* (
	directory: string,
	entry: EntryInput,
) {
	const path = yield* Path.Path
	const fs = yield* FileSystem.FileSystem
	const root = yield* fs.realPath(directory)
	const implementation = path.resolve(root, entry.implementation)
	const relative = path.relative(root, implementation)
	if (
		relative === "" ||
		String.startsWith("../")(relative) ||
		path.isAbsolute(relative)
	)
		return yield* failure("The implementation must stay inside its package")
	const module = yield* importModule(pathToFileURL(implementation).href)
	const plugin = yield* Effect.fromOption(Plugin.fromModule(module), () =>
		failure(`${implementation} exports no plugin`),
	)
	const contracts = yield* Effect.forEach(entry.contracts, (specifier) =>
		Effect.gen(function* () {
			const file = String.startsWith("file:")(specifier)
				? fileURLToPath(specifier)
				: yield* resolve(root, specifier)
			const owner = yield* packageAt(file)
			if (owner.directory === root)
				return yield* failure(
					"Publish contracts in a separate package; embedding a package's own directory digest in its manifest would change that digest",
				)
			const loaded = yield* importModule(pathToFileURL(file).href)
			const contract = yield* Effect.fromOption(
				Contract.fromModule(loaded),
				() => failure(`${specifier} exports no contract`),
			)
			return {
				contract,
				owner,
				declarations: declarations(contract, owner),
			}
		}),
	)
	const declared = Array.flatMap(contracts, (item) => item.declarations)
	const metadata = yield* Manifest.derive(plugin, declared)
	const conflicts = Manifest.conflicts([
		{ id: plugin.name, operations: metadata.operations },
	])
	if (conflicts.length > 0)
		return yield* failure(
			Array.join(
				Array.map(conflicts, (item) => item.message),
				"\n",
			),
		)
	return { ...entry, ...metadata } satisfies Manifest.EntryMetadata
})
