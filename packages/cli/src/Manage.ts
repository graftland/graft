/**
 * Creating projects and changing their dependencies.
 */
import * as Create from "@graftland/create"
import * as PackageManager from "@graftland/package-manager"
import {
	Array,
	Config,
	Effect,
	Option,
	Predicate,
	Record,
	Schema,
} from "effect"

const report = (result: PackageManager.InstallResult) =>
	Effect.logInfo(
		`${result.agent}: ${result.added.length} added, ${result.updated.length} updated, ${result.removed.length} removed`,
	)

/**
 * `name@range`, split at the last `@` so a scope's `@` stays in the name. A
 * bare name means the latest version.
 */
const Spec = Schema.Union([
	Schema.TemplateLiteralParser([
		PackageManager.PackageName,
		"@",
		Schema.String,
	]),
	PackageManager.PackageName,
])
const decodeSpecs = Schema.decodeEffect(Schema.Array(Spec))

const install = (
	directory: string,
	changes: Readonly<Record<string, string | null>>,
) =>
	Effect.gen(function* () {
		const decoded = yield* Schema.decodeEffect(PackageManager.Changes)(changes)
		// Set by npm, pnpm and Yarn when they run graft, such as through `pnpm dlx`.
		const userAgent = yield* Config.String("npm_config_user_agent").pipe(
			Config.withDefault(""),
		)
		const manager = yield* PackageManager.make({ directory, userAgent })
		const result = yield* manager.install(decoded)
		yield* report(result)
	})

export const create = (options: {
	readonly directory: string
	readonly name: Option.Option<string>
	readonly install: boolean
}) =>
	Effect.gen(function* () {
		const project = yield* Create.create({
			directory: options.directory,
			...Option.match(options.name, {
				onNone: () => ({}),
				onSome: (name) => ({ name }),
			}),
		})
		yield* Effect.logInfo(`Created ${project.name} in ${project.directory}`)
		if (options.install) yield* install(project.directory, {})
	})

export const add = (specs: ReadonlyArray<string>) =>
	Effect.flatMap(decodeSpecs(specs), (specs) =>
		install(
			".",
			Record.fromEntries(
				Array.map(specs, (spec) =>
					Predicate.isString(spec)
						? ([spec, "latest"] as const)
						: ([spec[0], spec[2]] as const),
				),
			),
		),
	)

export const remove = (names: ReadonlyArray<string>) =>
	install(
		".",
		Record.fromEntries(Array.map(names, (name) => [name, null] as const)),
	)
