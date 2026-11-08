import { cp, writeFile } from "node:fs/promises"

import { build } from "tsdown"

import packageConfig from "../../../tsdown.config.ts"

export default function setup() {
	return build({
		config: false,
		entry: [new URL("./runtime.ts", import.meta.url).pathname],
		outDir: new URL("../.cache/integration", import.meta.url).pathname,
		format: "esm",
		platform: "node",
		dts: false,
		deps: {
			alwaysBundle: ["@graftland/graft", "@graftland/hmr", "@graftland/loader"],
			neverBundle: [/^effect(?:\/|$)/],
		},
		inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
	})
		.then(() =>
			build({
				config: false,
				entry: ["plugin", "command-plugin"].map(
					(name) => new URL(`./${name}.ts`, import.meta.url).pathname,
				),
				outDir: new URL("../.cache/integration", import.meta.url).pathname,
				clean: false,
				format: "esm",
				platform: "node",
				dts: false,
				deps: {
					alwaysBundle: ["@graftland/graft", "@graftland/cli"],
					neverBundle: [/^effect(?:\/|$)/],
				},
				inputOptions: {
					resolve: { conditionNames: ["source", "import", "node"] },
				},
			}),
		)
		.then(() =>
			Promise.all(
				["cli", "create", "package-manager"].map((name) =>
					build({
						...packageConfig,
						config: false,
						entry: (name === "cli"
							? ["../src/bin.ts"]
							: name === "create"
								? ["../../create/src/index.ts", "../../create/src/Command.ts"]
								: [`../../${name}/src/index.ts`]
						).map((entry) => new URL(entry, import.meta.url).pathname),
						outDir: new URL(`../.cache/commands/${name}`, import.meta.url)
							.pathname,
						dts: false,
						exports: false,
					}),
				),
			),
		)
		.then(() =>
			// Located relative to create's modules, as in the published package.
			cp(
				new URL("../../create/templates", import.meta.url),
				new URL("../.cache/commands/templates", import.meta.url),
				{ recursive: true },
			),
		)
		.then(() =>
			writeFile(
				new URL("../.cache/commands/package.json", import.meta.url),
				'{"version":"0.0.0","type":"module"}',
			),
		)
		.then(() => undefined)
}
