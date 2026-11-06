import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

import { Cause, Effect, FileSystem, Path, Schema } from "effect"

import { Manifest } from "@graftland/graft"

import * as Artifact from "../Artifact"
import { PublicationError } from "./publicationModel"

const failure = (message: string, cause?: Cause.Cause<unknown>) =>
	PublicationError.make({ message, ...(cause === undefined ? {} : { cause }) })
export const readJson = Effect.fnUntraced(function* (file: string) {
	const fs = yield* FileSystem.FileSystem
	return yield* fs
		.readFileString(file)
		.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
				),
			),
		)
})
export const resolve = (directory: string, specifier: string) =>
	Effect.try({
		try: () =>
			createRequire(pathToFileURL(`${directory}/package.json`)).resolve(
				specifier,
			),
		catch: (cause) =>
			failure(
				`Cannot resolve ${specifier} from ${directory}; install the contract package with a Node default export`,
				Cause.die(cause),
			),
	})
export const packageAt = Effect.fnUntraced(function* (filename: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const resolved = yield* fs.realPath(filename)
	for (
		let directory = path.dirname(resolved);
		;
		directory = path.dirname(directory)
	) {
		const file = path.join(directory, "package.json")
		if (yield* fs.exists(file)) {
			const identity = yield* readJson(file).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Manifest.PackageIdentity)),
			)
			const artifact = yield* Artifact.directoryIdentity(directory)
			return { directory, package: identity, artifact }
		}
		if (directory === path.dirname(directory))
			return yield* failure(`No package identity for ${filename}`)
	}
})
