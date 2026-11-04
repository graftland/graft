import { Effect, Path, String } from "effect"
import { SecureRandom } from "effect/crypto"
import { registerHooks } from "node:module"

/** Bare names resolve from the application; imported dependencies keep their own parent URLs. */
export const make = Effect.fnUntraced(function* (directory: string) {
	const path = yield* Path.Path
	const base = yield* path.toFileUrl(path.join(directory, "graft.yml"))
	const random = yield* SecureRandom.SecureRandom
	const id = yield* random.uuidV4()
	const prefix = `graft-module-${id}:`
	yield* Effect.acquireRelease(
		Effect.sync(() =>
			registerHooks({
				resolve: (specifier, context, next) =>
					String.startsWith(prefix)(specifier)
						? next(String.slice(prefix.length)(specifier), {
								...context,
								parentURL: base.href,
							})
						: next(specifier, context),
			}),
		),
		(hooks) => Effect.sync(() => hooks.deregister()),
	)
	return (specifier: string): Promise<unknown> => import(prefix + specifier)
})
