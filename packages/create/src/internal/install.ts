import { Effect, Option, Schema } from "effect"

import * as PackageManager from "@graftland/package-manager"

/** Installs a new project's dependencies with the chosen package manager. */
export const install = Effect.fn("Create.install")(function* (
	directory: string,
	agent: PackageManager.Agent,
) {
	const changes = yield* Schema.decodeEffect(PackageManager.Changes)({})
	const manager = yield* PackageManager.make({ directory, agent })
	const result = yield* manager.install(changes)
	if (Option.isSome(result.snapshotCleanupFailure)) {
		const { cause, snapshotDirectory } = result.snapshotCleanupFailure.value
		yield* Effect.logWarning(
			"Installation committed; snapshot cleanup failed. Retry removing the retained snapshot.",
			cause,
			{ snapshotDirectory },
		)
	}
	return result
})
