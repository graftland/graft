import { Array as Arr, Effect, Record, Schema, String as Str } from "effect"

export const PackageName = Schema.String.check(
	Schema.isPattern(/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i),
	Schema.isMaxLength(214),
)
const Dependencies = Schema.Record(PackageName, Schema.String)
export const Manifest = Schema.StructWithRest(
	Schema.Struct({
		packageManager: Schema.optionalKey(Schema.String),
		dependencies: Schema.optionalKey(Dependencies),
		devDependencies: Schema.optionalKey(Dependencies),
		optionalDependencies: Schema.optionalKey(Dependencies),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
)
export type Manifest = typeof Manifest.Type
export const decodeManifest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Manifest),
)
export const Changes = Schema.Record(
	PackageName,
	Schema.Union([Schema.String.check(Schema.isPattern(/\S/)), Schema.Null]),
)
/** A spec adds or updates a dependency; null removes it from all dependency fields. */
export type Changes = typeof Changes.Type
export const fields = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
] as const

export const applyChanges = (
	manifest: Manifest,
	changes: Changes,
): Manifest => {
	let next = manifest
	for (const [name, spec] of Record.toEntries(changes)) {
		const existing = Arr.filter(fields, (field) =>
			Record.has(next[field] ?? {}, name),
		)
		const targets =
			spec === null
				? fields
				: existing.length > 0
					? existing
					: (["dependencies"] as const)
		for (const field of targets) {
			const deps = next[field] ?? {}
			next = {
				...next,
				[field]:
					spec === null
						? Record.remove(deps, name)
						: Record.set(deps, name, spec),
			}
		}
	}
	return next
}

export const encodeManifest = Effect.fnUntraced(function* (
	manifest: Manifest,
	original: string,
) {
	const space = /^[{[]\r?\n([ \t]+)/.exec(original)?.[1] ?? 2
	const text = yield* Schema.encodeEffect(
		Schema.fromJsonString(Manifest, { space }),
	)(manifest)
	const eol = Str.includes("\r\n")(original) ? "\r\n" : "\n"
	return Str.replaceAll("\n", eol)(text) + (/\r?\n$/.test(original) ? eol : "")
})
