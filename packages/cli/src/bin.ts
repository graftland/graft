#!/usr/bin/env node
/**
 * The `graft` executable. Running this module starts the program.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { version } from "../package.json" with { type: "json" }

const start = Command.make(
	"start",
	{
		config: Argument.String("config").pipe(
			Argument.withDescription("Path of the config file"),
			Argument.withDefault("graft.yml"),
		),
		watch: Flag.Boolean("watch").pipe(
			Flag.withAlias("w"),
			Flag.withDescription("Reload plugins and config when files change"),
			Flag.withDefault(false),
		),
		envFile: Flag.String("env-file").pipe(
			Flag.withDescription(
				"Read variables for !env from a .env file; the process environment takes precedence",
			),
			Flag.optional,
		),
	},
	(options) =>
		Effect.promise(() => import("./Start")).pipe(
			Effect.flatMap((Start) =>
				Start.run({
					...options,
					envFile: Option.getOrUndefined(options.envFile),
				}),
			),
		),
).pipe(
	Command.withDescription("Run the application described by a config file"),
)

const create = Command.make(
	"create",
	{
		directory: Argument.String("directory").pipe(
			Argument.withDescription("Where to create the project"),
		),
		name: Flag.String("name").pipe(
			Flag.withDescription("Package name; defaults to the directory name"),
			Flag.optional,
		),
		install: Flag.Boolean("install").pipe(
			Flag.withDescription("Install dependencies afterwards"),
			Flag.withDefault(false),
		),
	},
	(options) =>
		Effect.promise(() => import("./Manage")).pipe(
			Effect.flatMap((Manage) => Manage.create(options)),
		),
).pipe(Command.withDescription("Create a new Graft project"))

const add = Command.make(
	"add",
	{ packages: Argument.variadic(Argument.String("package")) },
	({ packages }) =>
		Effect.promise(() => import("./Manage")).pipe(
			Effect.flatMap((Manage) => Manage.add(packages)),
		),
).pipe(
	Command.withDescription(
		"Add dependencies, restoring the project if installing fails",
	),
)

const remove = Command.make(
	"remove",
	{ packages: Argument.variadic(Argument.String("package")) },
	({ packages }) =>
		Effect.promise(() => import("./Manage")).pipe(
			Effect.flatMap((Manage) => Manage.remove(packages)),
		),
).pipe(
	Command.withDescription(
		"Remove dependencies, restoring the project if installing fails",
	),
)

const graft = Command.make("graft").pipe(
	Command.withDescription("Run and manage Graft applications"),
	Command.withSubcommands([start, create, add, remove]),
)

Command.run(graft, { version }).pipe(
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
)
