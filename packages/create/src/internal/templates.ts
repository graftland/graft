/**
 * The project templates. Each one copies a directory of files and
 * generates package.json and graft.yml, the files that name the project, its
 * versions and its plugins. A template from elsewhere, such as a registry,
 * only needs another way to provide the static directory.
 */
import { Array, Effect, Path, Record, Schema, String } from "effect"

export const TemplateName = Schema.Literals(["app", "plugin", "minimal"])
export type TemplateName = typeof TemplateName.Type

/** A dependency on a plugin package, listed in graft.yml by its package name. */
export interface PluginDependency {
	readonly name: string
	readonly range: string
}

/** What a template generates from. */
export interface Context {
	readonly name: string
	/** Written to package.json only when given. */
	readonly packageManager: string | undefined
	readonly versions: {
		readonly graft: string
		readonly loader: string
		readonly cli: string
		readonly effect: string
	}
	readonly plugins: ReadonlyArray<PluginDependency>
}

export interface Template {
	readonly name: TemplateName
	readonly description: string
	/** The package name used when none is given. */
	readonly defaultName: (directory: string) => string
	/**
	 * The directory of files to copy. `_gitignore` becomes `.gitignore`, and
	 * `{{package}}` in a text file becomes the package name.
	 */
	readonly files: Effect.Effect<string, never, Path.Path>
	readonly manifest: (context: Context) => Readonly<Record<string, unknown>>
	readonly config: (context: Context) => string
}

/** Development tools of the TypeScript templates. */
const toolchain = {
	"@effect/tsgo": "^0.64.1",
	"@types/node": "^22.0.0",
	typescript: "^7.0.2",
}
const engines = { node: ">=22.19.0" }

const bundled = (name: TemplateName) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		// A module loaded from disk always has a file URL.
		return yield* path
			.fromFileUrl(new URL(`../../templates/${name}`, import.meta.url))
			.pipe(Effect.orDie)
	})

/** The editor schema that `graft schema` writes once the plugins are installed. */
const header = "# yaml-language-server: $schema=./graft.schema.json\n"

/** Package names are JSON strings, which YAML reads as quoted scalars; `@` cannot start a plain one. */
const pluginEntries = (context: Context) =>
	Array.join(
		Array.map(context.plugins, (plugin) => `- name: "${plugin.name}"\n`),
		"",
	)

const pluginDependencies = (context: Context) =>
	Record.fromEntries(
		Array.map(
			context.plugins,
			(plugin) => [plugin.name, plugin.range] as const,
		),
	)

/** A range for an exact version, accepting compatible releases; other specifiers stay as they are. */
const compatible = (prefix: "^" | "~", version: string) =>
	/^\d/.test(version) ? `${prefix}${version}` : version

const dependencies = (context: Context) => ({
	"@graftland/graft": context.versions.graft,
	"@graftland/loader": context.versions.loader,
	"@graftland/cli": context.versions.cli,
	effect: context.versions.effect,
	...pluginDependencies(context),
})

const identity = (context: Context) => ({
	name: context.name,
	version: "0.0.0",
	...(context.packageManager === undefined
		? {}
		: { packageManager: context.packageManager }),
})

const app: Template = {
	name: "app",
	description:
		"An application with example plugins and a service in TypeScript",
	defaultName: (directory) => directory,
	files: bundled("app"),
	manifest: (context) => ({
		...identity(context),
		private: true,
		type: "module",
		engines,
		scripts: {
			start: "graft start",
			build: "tsc -p tsconfig.build.json",
			dev: "tsc -p tsconfig.build.json && (tsc -p tsconfig.build.json --watch --preserveWatchOutput & graft start --watch)",
			typecheck: "effect-tsgo tsc",
		},
		dependencies: dependencies(context),
		devDependencies: toolchain,
	}),
	config: (context) =>
		header +
		`- id: hello
  name: ./dist/hello.js
  config:
    message: Hello from Graft!
- id: greeter
  name: ./dist/greeter.js
  config:
    greeting: Hello
- id: ticker
  name: ./dist/ticker.js
  config:
    name: Graft
` +
		pluginEntries(context),
}

const plugin: Template = {
	name: "plugin",
	description: "A plugin package to publish, with tests",
	defaultName: (directory) =>
		String.startsWith("graft-plugin-")(directory)
			? directory
			: `graft-plugin-${directory}`,
	files: bundled("plugin"),
	manifest: (context) => ({
		...identity(context),
		type: "module",
		keywords: ["graft-plugin"],
		engines,
		exports: {
			".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
		},
		files: ["dist"],
		scripts: {
			build: "tsc -p tsconfig.build.json",
			dev: "tsc -p tsconfig.build.json && (tsc -p tsconfig.build.json --watch --preserveWatchOutput & graft start --watch)",
			test: "vitest run",
			typecheck: "effect-tsgo tsc",
			prepublishOnly: "tsc -p tsconfig.build.json",
		},
		// The application provides Graft and Effect, so every plugin shares one copy.
		peerDependencies: {
			"@graftland/graft": compatible("^", context.versions.graft),
			effect: compatible("~", context.versions.effect),
		},
		...(context.plugins.length === 0
			? {}
			: {
					dependencies: pluginDependencies(context),
				}),
		devDependencies: {
			"@graftland/graft": context.versions.graft,
			"@graftland/cli": context.versions.cli,
			effect: context.versions.effect,
			"@effect/vitest": context.versions.effect,
			vitest: "^5.1.0",
			...toolchain,
		},
	}),
	config: (context) =>
		header +
		`- id: greeter
  name: ./dist/index.js
  config:
    name: Graft
` +
		pluginEntries(context),
}

const minimal: Template = {
	name: "minimal",
	description: "Only package.json and graft.yml, with no plugins of its own",
	defaultName: (directory) => directory,
	files: bundled("minimal"),
	manifest: (context) => ({
		...identity(context),
		private: true,
		type: "module",
		engines,
		scripts: { start: "graft start" },
		dependencies: dependencies(context),
	}),
	config: (context) =>
		header + (context.plugins.length === 0 ? "[]\n" : pluginEntries(context)),
}

export const templates: Readonly<Record<TemplateName, Template>> = {
	app,
	plugin,
	minimal,
}
