import { build } from "tsdown"

export default function setup() {
	return build({
		config: false,
		entry: ["runner", "plugin"].map(
			(name) => new URL(`./fixtures/${name}.ts`, import.meta.url).pathname,
		),
		outDir: new URL("../.cache/integration", import.meta.url).pathname,
		format: "esm",
		fixedExtension: false,
		platform: "node",
		dts: false,
		deps: {
			alwaysBundle: ["@graftland/graft"],
			neverBundle: [/^effect(?:\/|$)/, /^@effect\//],
		},
		inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
	}).then(() => undefined)
}
