import { Effect } from "effect"
import process from "node:process"
import { fileURLToPath } from "node:url"

/** Resolve the executable through the installed package export, never a relative dist path. */
export const command = (override?: readonly [string, ...string[]]) =>
	Effect.sync(
		(): readonly [string, ...string[]] =>
			override ?? [
				process.execPath,
				fileURLToPath(import.meta.resolve("@graftland/remote/bin")),
			],
	)
