// @effect-diagnostics-next-line nodeBuiltinImport:off -- watcher paths use host-platform syntax without adding a Path service requirement
import { resolve } from "node:path"
import type { FileVersion } from "./modules"
import type { WatchOptions } from "../index"
import { Base64 } from "effect/encoding"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
	Array,
	Cause,
	Exit,
	Effect,
	FileSystem,
	HashMap,
	Ref,
	Queue,
	Option,
	Stream,
	String,
} from "effect"

export type WithFiles = <A, E, R>(
	use: (files: HashMap.HashMap<string, FileVersion>) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>

/** Observe the producer after its resource scope closes, before merge can discard its Exit. */
const observeSource = <A, E, R>(source: Stream.Stream<A, E, R>) =>
	Stream.callback<A, E, R>(
		(queue) =>
			source.pipe(
				Stream.runForEachArray((values) => Queue.offerAll(queue, values)),
				Effect.scoped,
				Effect.onExit((exit) =>
					Exit.isFailure(exit) &&
					Cause.hasInterrupts(exit.cause) &&
					!Cause.hasInterruptsOnly(exit.cause)
						? Effect.logError(
								"Native watcher failed during cancellation",
								exit.cause,
							)
						: Effect.void,
				),
				Effect.andThen(Queue.end(queue)),
			),
		{ bufferSize: 16 },
	)

/** Reconcile loaded modules because native watchers can silently miss events. */
export const changes = (
	withFiles: WithFiles,
	paths: ReadonlyArray<string>,
	options?: WatchOptions,
) =>
	Stream.unwrap(
		Effect.gen(function* () {
			if (paths.length === 0) return Stream.empty
			const fs = yield* FileSystem.FileSystem
			const roots = yield* Effect.forEach(paths, (path) =>
				Effect.gen(function* () {
					const canonical = yield* fs.realPath(path)
					const info = yield* fs.stat(canonical)
					return {
						path: canonical,
						urls: [
							pathToFileURL(canonical).href,
							pathToFileURL(resolve(path)).href,
						],
						directory: info.type === "Directory",
					}
				}),
			)
			const accepted = (path: string) => options?.filter?.(path) ?? true
			const watched = (url: string) =>
				accepted(fileURLToPath(url)) &&
				Array.some(roots, ({ urls }) =>
					Array.some(urls, (root) => {
						const directory = String.endsWith("/")(root) ? root : `${root}/`
						return (
							fileURLToPath(url) === fileURLToPath(root) ||
							(options?.recursive === true
								? String.startsWith(directory)(url)
								: new URL(".", url).href === directory)
						)
					}),
				)

			const snapshot = withFiles((loaded) =>
				Effect.forEach(
					Array.filter(Array.fromIterable(loaded), ([url]) => watched(url)),
					([url, baseline]) =>
						Effect.gen(function* () {
							const resolution =
								baseline.resolution === undefined
									? undefined
									: yield* fs.realPath(fileURLToPath(url)).pipe(
											Effect.map((path) => pathToFileURL(path).href),
											Effect.catchIf(
												(error) => error.reason._tag === "NotFound",
												() => Effect.undefined,
											),
										)
							const content = yield* fs.readFile(fileURLToPath(url)).pipe(
								Effect.map(Base64.encode),
								// Deletion is a change; other I/O failures belong to the consumer.
								Effect.catchIf(
									(error) => error.reason._tag === "NotFound",
									() => Effect.undefined,
								),
							)
							return { url, baseline, content, resolution }
						}),
				),
			)
			// An observation acknowledges disk bytes only for the import version
			// it reconciled. A new attempt must be checked against its own bytes.
			const observed = yield* Ref.make(
				HashMap.empty<
					string,
					{
						readonly baseline: FileVersion
						readonly content: string | undefined
						readonly resolution: string | undefined
					}
				>(),
			)
			return Stream.mergeAll(
				[
					...Array.map(roots, (root) =>
						fs.watch(root.path, options).pipe(
							observeSource,
							Stream.filter((event) =>
								accepted(
									root.directory ? resolve(root.path, event.path) : root.path,
								),
							),
							Stream.map(() => true),
						),
					),
					Stream.tick("1 second").pipe(
						Stream.drop(1),
						Stream.map(() => false),
					),
				],
				{ concurrency: "unbounded" },
			).pipe(
				// One consumer serializes snapshots from events and polling. A native
				// event also advances the baseline, avoiding a second reload on the next tick.
				Stream.mapEffect((event) =>
					snapshot.pipe(
						Effect.flatMap((current) =>
							Ref.modify(observed, (before) => [
								event ||
									Array.some(
										current,
										({ url, baseline, content, resolution }) => {
											const expected = Option.match(HashMap.get(before, url), {
												onNone: () => ({
													content: baseline.content,
													resolution: baseline.resolution,
												}),
												onSome: (seen) => {
													const same =
														seen.baseline.generation === baseline.generation &&
														seen.baseline.content === baseline.content &&
														seen.baseline.resolution === baseline.resolution
													return {
														// Failed attempts without source bytes keep the last
														// observation acknowledged until another save.
														content:
															baseline.content === undefined || same
																? seen.content
																: baseline.content,
														resolution: same
															? seen.resolution
															: baseline.resolution,
													}
												},
											})
											return (
												expected.content !== content ||
												expected.resolution !== resolution
											)
										},
									),
								HashMap.fromIterable(
									Array.map(
										current,
										({ url, baseline, content, resolution }) =>
											[url, { baseline, content, resolution }] as const,
									),
								),
							]),
						),
					),
				),
				Stream.filter(Boolean),
				Stream.map(() => undefined),
			)
		}),
	)
