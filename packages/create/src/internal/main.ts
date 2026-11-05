/** What `create` does after parsing: answer, generate, install, initialize git, and say what is next. */
import {
	Array,
	Console,
	Effect,
	Exit,
	Path,
	Schema,
	String,
	Terminal,
} from "effect"
import { CliError } from "effect/cli"

import * as PackageManager from "@graftland/package-manager"

import {
	create,
	CreateError,
	InvalidName,
	InvalidPackageManager,
} from "../index"
import * as Git from "./git"
import { install } from "./install"
import { resolve, type Input } from "./resolve"

/** A path as typed in a shell; anything but plain characters is single-quoted. */
const shellQuote = (value: string) =>
	/^[\w@%+=:,./-]+$/.test(value)
		? value
		: `'${String.replaceAll("'", `'\\''`)(value)}'`

const scripts = {
	app: ["dev"],
	plugin: ["test", "dev"],
	minimal: ["dev"],
} as const

/** A mistake in the answers, shown as a message rather than a failure trace. */
const userError = (
	error: CreateError | InvalidName | InvalidPackageManager,
): CliError.UserError =>
	CliError.UserError.make({
		cause: error,
		userMessage:
			error._tag === "CreateError"
				? `${error.directory}: ${error.message}`
				: error._tag === "InvalidName"
					? `Invalid package name ${error.packageName}: ${error.message}`
					: `Unsupported package manager ${error.value}: ${error.message}`,
	})

const isMistake = Schema.is(
	Schema.Union([CreateError, InvalidName, InvalidPackageManager]),
)
const reportMistakes = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.mapError(effect, (error) =>
		isMistake(error) ? userError(error) : error,
	)

export const main = Effect.fn("Create.main")(function* (input: Input) {
	const path = yield* Path.Path
	const answers = yield* resolve(input).pipe(
		Effect.catchIf(Terminal.isQuitError, () =>
			Console.error("Cancelled").pipe(Effect.andThen(Effect.interrupt)),
		),
		reportMistakes,
	)
	const { agent, declaration } = answers.packageManager
	const project = yield* create({
		directory: answers.directory,
		template: answers.template,
		plugins: answers.plugins,
		...(answers.name === undefined ? {} : { name: answers.name }),
		...(declaration === undefined ? {} : { packageManager: declaration }),
	}).pipe(reportMistakes)
	yield* Console.log(
		`Created ${project.name} in ${project.directory} from the ${project.template} template`,
	)

	const installed = answers.install
		? yield* Effect.exit(install(project.directory, agent))
		: undefined
	if (installed !== undefined && Exit.isFailure(installed))
		yield* Effect.logError(
			"Installing dependencies failed; the project is kept",
			installed.cause,
		)

	const git = answers.git
		? yield* Effect.exit(Git.init(project.directory))
		: undefined
	if (git !== undefined) {
		if (Exit.isFailure(git))
			yield* Effect.logError(
				"Initializing a git repository failed; the project is kept",
				git.cause,
			)
		else if (git.value === "missing")
			yield* Console.log("Skipped git: it is not installed")
		else if (git.value === "inside")
			yield* Console.log("Skipped git: the project is inside a repository")
	}

	const relative = path.relative(path.resolve("."), project.directory)
	const steps = [
		...(relative === "" ? [] : [`cd ${shellQuote(relative)}`]),
		...(installed === undefined || Exit.isFailure(installed)
			? [PackageManager.installCommand(agent)]
			: []),
		...(git !== undefined && Exit.isFailure(git) ? ["git init"] : []),
		...Array.map(
			scripts[project.template],
			(script) => `${PackageManager.runPrefix(agent)} ${script}`,
		),
	]
	yield* Console.log(
		`\nNext steps:\n${Array.join(
			Array.map(steps, (step) => `  ${step}`),
			"\n",
		)}`,
	)

	const failures = [
		...(installed !== undefined && Exit.isFailure(installed)
			? [installed.cause]
			: []),
		...(git !== undefined && Exit.isFailure(git) ? [git.cause] : []),
	]
	if (failures.length > 0)
		return yield* CliError.UserError.make({
			cause: failures,
			userMessage: "The project was created, but a step after it failed",
		})
})
