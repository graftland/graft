// Bundled for integration tests so imports use Node's loader, not Vite's module runner.
export * as Hmr from "../src/index.ts"
export { Graft, Plugin, Transition } from "@graftland/graft"

export { modules } from "../src/internal/modules.ts"

export const nativeImport = (specifier: string): Promise<unknown> =>
	import(/* @vite-ignore */ specifier)
