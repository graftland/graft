/**
 * The `create` command, shared by `npm create @graftland` and `graft create`.
 * Importing this module only defines the command; running it loads the rest.
 */
import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import { TemplateName } from "./internal/templates"

export const command = Command.make(
	"create",
	{
		directory: Argument.String("directory").pipe(
			Argument.withDescription(
				"Where to create the project; defaults to graft-app",
			),
			Argument.optional,
		),
		template: Flag.Literals("template", TemplateName.literals).pipe(
			Flag.withAlias("t"),
			Flag.withDescription("The template to start from; defaults to app"),
			Flag.optional,
		),
		name: Flag.String("name").pipe(
			Flag.withDescription(
				"Package name; defaults to the directory name, prefixed with graft-plugin- for plugins",
			),
			Flag.optional,
		),
		plugins: Flag.String("plugin").pipe(
			Flag.withDescription(
				"A plugin to depend on and load, as name or name@range; repeatable",
			),
			Flag.atLeast(0),
		),
		packageManager: Flag.String("package-manager").pipe(
			Flag.withDescription(
				"npm, pnpm or yarn, optionally @version to record it; defaults to the one running this command",
			),
			Flag.optional,
		),
		install: Flag.Boolean("install").pipe(
			Flag.withDescription("Install dependencies; on by default"),
			Flag.optional,
		),
		git: Flag.Boolean("git").pipe(
			Flag.withDescription("Initialize a git repository; on by default"),
			Flag.optional,
		),
		yes: Flag.Boolean("yes").pipe(
			Flag.withAlias("y"),
			Flag.withDescription("Answer every question with its default"),
			Flag.withDefault(false),
		),
	},
	(input) =>
		Effect.promise(() => import("./internal/main")).pipe(
			Effect.uninterruptible,
			Effect.flatMap((module) => module.main(input)),
		),
).pipe(Command.withDescription("Create a new Graft project"))
