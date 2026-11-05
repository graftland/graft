/**
 * Completes the parsed command line. A missing answer is asked when the
 * terminal can prompt and `--yes` is absent; otherwise it takes the answer
 * that pressing Enter would give. Nothing is written until every answer is in.
 */
import {
	Array,
	Config,
	Console,
	Effect,
	FileSystem,
	Option,
	Path,
	Record,
	Schema,
	String,
} from "effect"
import { Prompt, TerminalCapabilities } from "effect/cli"

import * as PackageManager from "@graftland/package-manager"
import { PackageManagerName } from "@graftland/package-manager/PackageManagerDeclaration"

import { checkTarget, InvalidName, InvalidPackageManager, Name } from "../index"
import * as Git from "./git"
import { templates, type TemplateName } from "./templates"

export interface Input {
	readonly directory: Option.Option<string>
	readonly template: Option.Option<TemplateName>
	readonly name: Option.Option<string>
	readonly plugins: ReadonlyArray<string>
	readonly packageManager: Option.Option<string>
	readonly install: Option.Option<boolean>
	readonly git: Option.Option<boolean>
	readonly yes: boolean
}

export interface Answers {
	readonly directory: string
	readonly template: TemplateName
	/** Absent when the template's default applies. */
	readonly name: string | undefined
	readonly plugins: ReadonlyArray<string>
	readonly packageManager: {
		readonly agent: PackageManager.Agent
		/** The `packageManager` field, written only when a version was given. */
		readonly declaration: string | undefined
	}
	readonly install: boolean
	readonly git: boolean
}

export const defaultDirectory = "graft-app"

/** `npm`, `pnpm` or `yarn`, with an optional exact version. */
const packageManager = Effect.fnUntraced(function* (
	value: Option.Option<string>,
) {
	if (Option.isNone(value)) {
		// Set by npm, pnpm and Yarn when they run this command, as `npm create` does.
		const userAgent = yield* Config.String("npm_config_user_agent").pipe(
			Config.withDefault(""),
		)
		return Option.match(PackageManager.parseUserAgent(userAgent), {
			onNone: () => ({ agent: "npm" as const, declaration: undefined }),
			onSome: ({ name, version }) => ({
				agent: PackageManager.agentFor(name, version),
				declaration: undefined,
			}),
		})
	}
	const [name = "", ...version] = String.split("@")(value.value)
	const decoded = yield* Schema.decodeUnknownEffect(PackageManagerName)(
		name,
	).pipe(
		Effect.mapError((error) =>
			InvalidPackageManager.make({
				value: value.value,
				message: error.message,
			}),
		),
	)
	return version.length === 0
		? { agent: PackageManager.agentFor(decoded), declaration: undefined }
		: {
				agent: PackageManager.agentFor(decoded, Array.join(version, "@")),
				declaration: value.value,
			}
})

export const resolve = Effect.fn("Create.resolve")(function* (input: Input) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { canPrompt } = yield* TerminalCapabilities.TerminalCapabilities
	const interactive = canPrompt && !input.yes
	const manager = yield* packageManager(input.packageManager)
	const explicitName = yield* Option.match(input.name, {
		onNone: () => Effect.succeedNone,
		onSome: (name) =>
			Schema.decodeEffect(Name)(name).pipe(
				Effect.mapBoth({
					onFailure: (error) =>
						InvalidName.make({ packageName: name, message: error.message }),
					onSuccess: Option.some,
				}),
			),
	})
	/** Prompt validation reports problems as text. */
	const problem = <A, E extends { readonly message: string }>(
		effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
	) =>
		effect.pipe(
			Effect.mapError((error) => error.message),
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provideService(Path.Path, path),
		)

	const given = Option.getOrElse(input.directory, () => defaultDirectory)
	const askDirectory = Effect.fnUntraced(function* () {
		if (Option.isSome(input.directory)) {
			const checked = yield* Effect.result(problem(checkTarget(given)))
			if (checked._tag === "Success") return given
			yield* Console.error(checked.failure)
		}
		return yield* Prompt.run(
			Prompt.String({
				message: "Where should the project go?",
				default: defaultDirectory,
				validate: (value) => problem(checkTarget(value)).pipe(Effect.as(value)),
			}),
		)
	})
	const directory = interactive
		? yield* askDirectory()
		: yield* checkTarget(given).pipe(Effect.as(given))

	const template: TemplateName = Option.isSome(input.template)
		? input.template.value
		: interactive
			? yield* Prompt.run(
					Prompt.Select({
						message: "Which template?",
						choices: Array.map(Record.values(templates), (template) => ({
							title: template.name,
							value: template.name,
							description: template.description,
						})),
					}),
				)
			: "app"

	const defaultName = templates[template].defaultName(
		path.basename(path.resolve(directory)),
	)
	const validName = Schema.is(Name)(defaultName)
	// The plugin name is a choice to make; other templates ask only when the directory gives no valid name.
	const name = Option.isSome(explicitName)
		? explicitName.value
		: interactive && (template === "plugin" || !validName)
			? yield* Prompt.run(
					Prompt.String({
						message: "Package name",
						...(validName ? { default: defaultName } : {}),
						validate: (value) =>
							Schema.decodeEffect(Name)(value).pipe(
								Effect.mapError((error) => error.message),
							),
					}),
				)
			: undefined

	const install = Option.isSome(input.install)
		? input.install.value
		: interactive
			? yield* Prompt.run(
					Prompt.Confirm({
						message: `Install dependencies with ${PackageManager.installCommand(manager.agent)}?`,
						initial: true,
					}),
				)
			: true

	const git = Option.isSome(input.git)
		? input.git.value
		: interactive && (yield* Git.probe(directory)) === "available"
			? yield* Prompt.run(
					Prompt.Confirm({
						message: "Initialize a git repository?",
						initial: true,
					}),
				)
			: true

	return {
		directory,
		template,
		name: name === defaultName ? undefined : name,
		plugins: input.plugins,
		packageManager: manager,
		install,
		git,
	} satisfies Answers
})
