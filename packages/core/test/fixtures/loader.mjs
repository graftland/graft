/**
 * Registers plain Node resolution with TypeScript support, so a fixture can be
 * spawned directly: relative imports without an extension resolve to their
 * `.ts` file or directory index, and Node strips the types itself.
 */
import { registerHooks } from "node:module"

registerHooks({
	resolve(specifier, context, next) {
		if (
			!specifier.startsWith(".") &&
			!specifier.startsWith("/") &&
			!specifier.startsWith("file:")
		)
			return next(specifier, context)
		try {
			return next(specifier, context)
		} catch (error) {
			for (const suffix of [".ts", "/index.ts"]) {
				try {
					return next(specifier + suffix, context)
				} catch {}
			}
			throw error
		}
	},
})
