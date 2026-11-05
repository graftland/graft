import { fileURLToPath } from "node:url"

import {
	Array,
	Cause,
	Effect,
	FileSystem,
	HashMap,
	Option,
	Scope,
	Stream,
	SubscriptionRef,
} from "effect"

import { changes } from "./changes"
import { digest } from "./digest"
import type { FileVersion } from "./modules"

type Files = HashMap.HashMap<string, FileVersion>
interface Sources {
	readonly imports: HashMap.HashMap<string, Files>
	readonly explicit: Files
	/** Explicit files belong to the latest activation that registered any. */
	readonly activation: Option.Option<Scope.Scope>
}

/** An entry keeps its last known snapshots across execution and watcher failures. */
export const make = Effect.fnUntraced(function* () {
	const scope = yield* Effect.scope
	const fs = yield* FileSystem.FileSystem
	const sources = yield* SubscriptionRef.make({
		imports: HashMap.empty<string, Files>(),
		explicit: HashMap.empty<string, FileVersion>(),
		activation: Option.none<Scope.Scope>(),
	})
	const snapshot = (value: Sources): Files =>
		Array.reduce(
			HashMap.toValues(value.imports),
			value.explicit,
			(all, files) => HashMap.union(all, files),
		)
	const read = (url: string) =>
		fs.readFile(fileURLToPath(url)).pipe(
			Effect.map((bytes): readonly [string, FileVersion] => [
				url,
				{ generation: -1, content: digest(bytes) },
			]),
			Effect.catchIf(
				(error) => error.reason._tag === "NotFound",
				() =>
					Effect.succeed<readonly [string, FileVersion]>([
						url,
						{ generation: -1, content: undefined },
					]),
			),
		)
	// An activation may start several remote plugins, so its calls accumulate; a newer activation
	// replaces them, and files it no longer uses stop being observed.
	const watch = (files: ReadonlyArray<string>, activation: Scope.Scope) =>
		Effect.forEach(files, read).pipe(
			Effect.flatMap((entries) =>
				SubscriptionRef.update(sources, (current) => {
					const explicit = HashMap.union(
						Option.exists(current.activation, (owner) => owner === activation)
							? current.explicit
							: HashMap.empty<string, FileVersion>(),
						HashMap.fromIterable(entries),
					)
					return {
						...current,
						explicit,
						activation: Option.some(activation),
						imports: HashMap.filter(current.imports, (_, root) =>
							HashMap.has(explicit, root),
						),
					}
				}),
			),
			Effect.onError(() =>
				SubscriptionRef.update(sources, (current) => ({
					...current,
					explicit: HashMap.union(
						HashMap.fromIterable(
							Array.map(files, (url): readonly [string, FileVersion] => [
								url,
								{ generation: -1, content: undefined },
							]),
						),
						current.explicit,
					),
				})),
			),
		)
	const imported = (root: string, files: Files, success: boolean) =>
		SubscriptionRef.update(sources, (current) => ({
			...current,
			imports: HashMap.set(
				current.imports,
				root,
				success
					? files
					: HashMap.union(
							Option.getOrElse(
								HashMap.get(current.imports, root),
								HashMap.empty<string, FileVersion>,
							),
							files,
						),
			),
		}))
	const observe = SubscriptionRef.changes(sources).pipe(
		Stream.switchMap((current) => {
			const files = snapshot(current)
			if (HashMap.size(files) === 0) return Stream.never
			// Watch parent directories so deleting an entry does not prevent its recovery.
			return changes(
				(use) => use(files),
				Array.dedupe(
					Array.map(Array.fromIterable(HashMap.keys(files)), (url) =>
						fileURLToPath(new URL(".", url)),
					),
				),
				{ recursive: true },
			).pipe(Stream.as(undefined))
		}),
		Stream.provideService(FileSystem.FileSystem, fs),
	)
	const recover: Stream.Stream<void> = Stream.suspend(() =>
		observe.pipe(
			Stream.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Stream.failCause(
							Cause.fromReasons(
								Array.filter(cause.reasons, Cause.isInterruptReason),
							),
						)
					: Stream.fromEffect(
							Effect.logError(
								"Source observation failed; retrying",
								cause,
							).pipe(Effect.andThen(Effect.sleep("1 second"))),
						).pipe(Stream.drain, Stream.concat(recover)),
			),
		),
	)
	return { scope, watch, changes: recover, imported }
})
