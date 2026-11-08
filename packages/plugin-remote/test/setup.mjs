import { build } from "tsdown"

export default async function setup() {
	await build({
		config: false,
		entry: [
			"index",
			"Units",
			"Control",
			"Contract",
			"Artifact",
			"internal/nativeUnit",
			"internal/nativeUnitMain",
			"internal/kernelMain",
			"internal/jsonLines",
			"internal/publicationMain",
		].map((name) => new URL(`../src/${name}.ts`, import.meta.url).pathname),
		outDir: new URL("../dist", import.meta.url).pathname,
		root: new URL("../src", import.meta.url).pathname,
		format: "esm",
		fixedExtension: false,
		platform: "node",
		dts: false,
		clean: false,
		deps: {
			alwaysBundle: [/^@graftland\/(?:graft|loader|cli)(?:\/|$)/],
			neverBundle: [/^effect(?:\/|$)/, /^@effect\//],
		},
		inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
	})
}
