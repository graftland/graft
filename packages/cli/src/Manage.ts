/**
 * Creating projects and changing their dependencies.
 */
import { parseDocument, type Document } from "yaml"
import { home } from "./internal/commandConfig"
import { CommandConfigError } from "./Commands"

import * as Create from "@graftland/create"
import * as PackageManager from "@graftland/package-manager"
import {
	Array,
	Config,
	Effect,
	FileSystem,
	Path,
	Option,
	Predicate,
	Record,
	Schema,
	String,
} from "effect"

const report = (result: PackageManager.InstallResult) =>
	Effect.logInfo(
		`${result.agent}: ${result.added.length} added, ${result.updated.length} updated, ${result.removed.length} removed`,
	).pipe(
		Effect.andThen(
			Option.match(result.snapshotCleanupFailure, {
				onNone: () => Effect.void,
				onSome: ({ cause, snapshotDirectory }) =>
					Effect.logWarning(
						"Installation committed; snapshot cleanup failed. Retry removing the retained snapshot.",
						cause,
						{ snapshotDirectory },
					),
			}),
		),
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

const enabledConfig = Effect.fnUntraced(function* (
	file: string,
	module: string,
) {
	const fs = yield* FileSystem.FileSystem
	const text = (yield* fs.exists(file))
		? yield* fs.readFileString(file)
		: "[]\n"
	const document = yield* Effect.try({
		try: () => {
			const document: Document = parseDocument(text)
			const error = document.errors[0]
			if (error !== undefined) throw error
			if (document.toJS() === null) document.contents = document.createNode([])
			return document
		},
		catch: (cause) => CommandConfigError.make({ file, cause }),
	})
	const entries = yield* Schema.decodeUnknownEffect(
		Schema.Array(Schema.Unknown),
	)(document.toJS())
	const existing = Array.findFirstIndex(
		entries,
		(entry) =>
			Predicate.hasProperty(entry, "name") &&
			entry.name === module &&
			Predicate.hasProperty(entry, "cli") &&
			entry.cli === true,
	)
	return yield* Effect.try({
		try: () => {
			if (Option.isSome(existing))
				document.setIn([existing.value, "disabled"], false)
			else document.add({ name: module, cli: true })
			return document.toString()
		},
		catch: (cause) => CommandConfigError.make({ file, cause }),
	})
})
const prepareHome = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* fs.makeDirectory(directory, { recursive: true })
	const manifest = path.join(directory, "package.json")
	if (!(yield* fs.exists(manifest)))
		yield* fs.writeFileString(manifest, '{"private":true,"type":"module"}\n')
}, Effect.uninterruptible)

/** Install a command plugin and explicitly enable its /cli entry. */
export const addPlugin = Effect.fn("Manage.addPlugin")(function* (
	name: string,
	global: boolean = false,
) {
	const path = yield* Path.Path
	const fs = yield* FileSystem.FileSystem
	const directory = global ? yield* home : path.resolve(".")
	const packageName =
		String.startsWith("@")(name) || String.startsWith("graft-plugin-")(name)
			? name
			: `@graftland/plugin-${name}`
	const module = `${packageName}/cli`
	const file = path.join(directory, "graft.yml")
	const text = yield* enabledConfig(file, module)
	if (global) yield* prepareHome(directory)
	yield* install(directory, Record.singleton(packageName, "latest"))
	// Once accepted, the native write must finish before command cleanup can proceed.
	yield* fs.writeFileString(file, text).pipe(Effect.uninterruptible)
	yield* Effect.logInfo(`Enabled ${module} in ${file}`)
})
