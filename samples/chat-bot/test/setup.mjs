import { build } from "tsdown"

export default async function setup() {
	await build({
		config: false,
		root: new URL("../src", import.meta.url).pathname,
		entry: ["forecastContract", "plugins/forecasts"].map(
			(name) => new URL(`../src/${name}.ts`, import.meta.url).pathname,
		),
		outDir: new URL("../.cache/implementation", import.meta.url).pathname,
		format: "esm",
		platform: "node",
		fixedExtension: false,
		dts: false,
		deps: {
			alwaysBundle: [
				"@graftland/graft",
				"@graftland/plugin-remote",
				"@graftland/loader",
			],
			neverBundle: [/^effect(?:\/|$)/, /^@effect\//],
		},
		inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
	})
}
