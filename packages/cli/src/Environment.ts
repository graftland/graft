/**
 * The `!env` sources of `graft start` as a unit environment module: the
 * process environment, then `--env-file`, then `--env-dir`.
 */
import { Effect, Layer, Schema } from "effect"

import { Options } from "@graftland/plugin-remote/Configuration"

import { layer as env } from "./internal/env"

/** Services the layer also provides for watching the file and the directory. */
export { EnvDir, EnvFile, type Reload } from "./internal/env"

export const Sources = Schema.Struct({
	file: Schema.optionalKey(Schema.String),
	dir: Schema.optionalKey(Schema.String),
})
export type Sources = typeof Sources.Type

/** Built inside the unit from encoded options; the host passes only the two paths. */
export default Layer.unwrap(
	Effect.gen(function* () {
		const options = yield* Options
		const sources = yield* Schema.decodeUnknownEffect(Sources)(options)
		return env(sources)
	}),
)
