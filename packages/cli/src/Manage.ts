/**
 * Creating projects and changing their dependencies.
 */
import * as Create from "@nmnmcc/graft-create"
import * as PackageManager from "@nmnmcc/graft-package-manager"
import {
	Array as Arr,
	Effect,
	Option,
	Record,
	Schema,
	String as Str,
} from "effect"

const report = (result: PackageManager.InstallResult) =>
	Effect.logInfo(
		`${result.agent}: ${result.added.length} added, ${result.updated.length} updated, ${result.removed.length} removed`,
	)

/** Splits `name@range` (the scope's `@` excluded); a bare name means the latest version. */
const parseSpec = (spec: string): readonly [string, string] =>
	Option.match(
		Option.filter(Str.lastIndexOf("@")(spec), (at) => at > 0),
		{
			onNone: () => [spec, "latest"] as const,
			onSome: (at) =>
				[Str.slice(0, at)(spec), Str.slice(at + 1)(spec)] as const,
		},
	)

const install = (
	directory: string,
	changes: Readonly<Record<string, string | null>>,
) =>
	Effect.gen(function* () {
		const decoded = yield* Schema.decodeEffect(PackageManager.Changes)(changes)
		const manager = yield* PackageManager.make({ directory })
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
	install(".", Record.fromEntries(Arr.map(specs, parseSpec)))

export const remove = (names: ReadonlyArray<string>) =>
	install(
		".",
		Record.fromEntries(Arr.map(names, (name) => [name, null] as const)),
	)
