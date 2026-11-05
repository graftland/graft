// @effect-diagnostics-next-line nodeBuiltinImport:off -- watcher paths use host-platform syntax without adding a Path service requirement
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
	Array,
	Cause,
	Clock,
	Effect,
	Equal,
	Exit,
	Fiber,
	FileSystem,
	HashMap,
	HashSet,
	Option,
	Queue,
	Ref,
	Stream,
	String,
} from "effect"

import type { WatchOptions } from "../index"
import { digest } from "./digest"
import type { FileVersion } from "./modules"

export type WithFiles = <A, E, R>(
	use: (files: HashMap.HashMap<string, FileVersion>) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>

/** Observe the producer after its resource scope closes, before merge can discard its Exit. */
const observeSource = <A, E, R>(source: Stream.Stream<A, E, R>) =>
	Stream.callback<A, E, R>(
		(queue) =>
			Effect.scoped(
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const id = yield* Effect.withFiber((self) =>
							Effect.succeed(self.id),
						)
						const producer = yield* Effect.forkScoped(
							restore(
								source.pipe(
									Stream.runForEachArray((values) =>
										Queue.offerAll(queue, values),
									),
									Effect.scoped,
								),
							),
						)
						const waiting = yield* Effect.exit(restore(Fiber.await(producer)))
						if (Exit.isFailure(waiting)) yield* Fiber.interrupt(producer)
						const exit = yield* Fiber.await(producer)
						// Only our own cancellation is expected; nested finalizers may contribute other interrupts.
						if (
							Exit.isFailure(exit) &&
							Cause.hasInterrupts(exit.cause) &&
							!(
								Exit.isFailure(waiting) &&
								Array.every(
									exit.cause.reasons,
									(reason) =>
										reason._tag === "Interrupt" && reason.fiberId === id,
								)
							)
						)
							yield* Effect.logError(
								"Native watcher failed during cancellation",
								exit.cause,
							)
						yield* exit
						yield* Queue.end(queue)
					}),
				),
			),
		{ bufferSize: 16 },
	)

/** Compare immutable observation tokens again after filesystem I/O releases the lock. */
const sameVersion = (a: FileVersion, b: FileVersion) =>
	a.generation === b.generation &&
	a.content === b.content &&
	a.resolution === b.resolution

/** Reconcile owned modules because native watchers can silently miss events. */
export const changes = (
	withFiles: WithFiles,
	paths: ReadonlyArray<string>,
	options?: WatchOptions,
) =>
	Stream.unwrap(
		Effect.gen(function* () {
			if (paths.length === 0) return Stream.empty
			const fs = yield* FileSystem.FileSystem
			const roots = yield* Effect.forEach(
				paths,
				Effect.fnUntraced(function* (path: string) {
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
				Array.some(roots, ({ urls, directory }) =>
					Array.some(urls, (root) => {
						const prefix = String.endsWith("/")(root) ? root : `${root}/`
						return (
							fileURLToPath(url) === fileURLToPath(root) ||
							(directory &&
								(options?.recursive === true
									? String.startsWith(prefix)(url)
									: new URL(".", url).href === prefix))
						)
					}),
				)
			const files = withFiles((loaded) =>
				Effect.succeed(HashMap.filter(loaded, (_, url) => watched(url))),
			)
			const missing = <
				A,
				E extends import("effect").PlatformError.PlatformError,
				R,
			>(
				effect: Effect.Effect<A, E, R>,
			) =>
				effect.pipe(
					Effect.catchIf(
						(error) => error.reason._tag === "NotFound",
						() => Effect.undefined,
					),
				)
			// Watch only graph directories, never recursively traverse an application root.
			// Missing descendants use their nearest existing ancestor until they appear.
			const existingDirectory: (
				path: string,
			) => Effect.Effect<string, import("effect").PlatformError.PlatformError> =
				Effect.fnUntraced(function* (path: string) {
					const info = yield* missing(fs.stat(path))
					return info?.type === "Directory" || dirname(path) === path
						? path
						: yield* existingDirectory(dirname(path))
				})
			const directories = Effect.gen(function* () {
				const loaded = yield* files
				const requested = HashSet.fromIterable([
					...Array.map(roots, (root) =>
						root.directory ? root.path : dirname(root.path),
					),
					...Array.map(Array.fromIterable(HashMap.keys(loaded)), (url) =>
						dirname(fileURLToPath(url)),
					),
				])
				const existing = yield* Effect.forEach(requested, existingDirectory, {
					concurrency: 8,
				})
				return HashSet.fromIterable(existing)
			})
			const dirty = yield* Ref.make(HashSet.empty<string>())
			const native = Stream.tick("1 second").pipe(
				Stream.mapEffect(() => directories),
				Stream.changesWith((a, b) => Equal.equals(a, b)),
				Stream.switchMap((directories) =>
					Stream.mergeAll(
						Array.map(Array.fromIterable(directories), (directory) =>
							fs.watch(directory, { ...options, recursive: false }).pipe(
								observeSource,
								Stream.map((event) => resolve(directory, event.path || ".")),
							),
						),
						{ concurrency: "unbounded" },
					),
				),
				Stream.tap((path) => Ref.update(dirty, HashSet.add(path))),
				Stream.debounce(options?.debounce ?? "50 millis"),
				Stream.mapEffect(() => Ref.getAndSet(dirty, HashSet.empty<string>())),
			)
			interface Observation {
				readonly baseline: FileVersion
				readonly content: string | undefined
				readonly resolution: string | undefined
				readonly stat: string
				readonly checked: number
			}
			const observed = yield* Ref.make(HashMap.empty<string, Observation>())
			const scan = Effect.fnUntraced(function* (
				events: HashSet.HashSet<string> | undefined,
			) {
				const loaded = yield* files
				const before = yield* Ref.get(observed)
				const now = yield* Clock.currentTimeMillis
				const selected = Array.filter(
					Array.fromIterable(loaded),
					([url]) =>
						events === undefined ||
						Array.some(Array.fromIterable(events), (path) => {
							const file = fileURLToPath(url)
							return file === path || String.startsWith(`${path}/`)(file)
						}),
				)
				const checked = yield* Effect.forEach(
					selected,
					Effect.fnUntraced(function* ([
						url,
						baseline,
					]: (typeof selected)[number]) {
						const path = fileURLToPath(url)
						const previous = Option.getOrUndefined(HashMap.get(before, url))
						const info = yield* missing(fs.stat(path))
						const stat =
							info === undefined
								? "missing"
								: `${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}:${Option.getOrUndefined(info.ino)}`
						const resolution =
							baseline.resolution === undefined
								? undefined
								: yield* missing(fs.realPath(path)).pipe(
										Effect.map((path) =>
											path === undefined ? undefined : pathToFileURL(path).href,
										),
									)
						const audit =
							events !== undefined ||
							previous === undefined ||
							!sameVersion(previous.baseline, baseline) ||
							previous.stat !== stat ||
							now - previous.checked >= 10000
						const content = audit
							? yield* missing(fs.readFile(path)).pipe(
									Effect.map((bytes) =>
										bytes === undefined ? undefined : digest(bytes),
									),
								)
							: previous.content
						const expected =
							previous === undefined
								? baseline
								: {
										content:
											baseline.content === undefined ||
											sameVersion(previous.baseline, baseline)
												? previous.content
												: baseline.content,
										resolution: sameVersion(previous.baseline, baseline)
											? previous.resolution
											: baseline.resolution,
									}
						return {
							url,
							observation: {
								baseline,
								content,
								resolution,
								stat,
								checked: audit ? now : previous.checked,
							},
							changed:
								expected.content !== content ||
								expected.resolution !== resolution,
						}
					}),
					{ concurrency: 8 },
				)
				// The immutable snapshot keeps its bytes alive while owners can be released.
				// A stale result cannot acknowledge a newer import, even when bytes coincide.
				return yield* withFiles((current) =>
					Ref.modify(observed, (seen) => {
						let next = HashMap.filter(seen, (_, url) =>
							HashMap.has(current, url),
						)
						let changed = HashSet.empty<string>()
						for (const { url, observation, changed: differs } of checked) {
							if (
								!Option.exists(HashMap.get(current, url), (version) =>
									sameVersion(version, observation.baseline),
								)
							)
								continue
							next = HashMap.set(next, url, observation)
							if (differs) changed = HashSet.add(changed, url)
						}
						return [changed, next]
					}),
				)
			})
			return Stream.merge(
				native,
				Stream.tick("1 second").pipe(
					Stream.drop(1),
					Stream.map(() => undefined),
				),
			).pipe(
				Stream.mapEffect(scan),
				Stream.filter((changed) => HashSet.size(changed) > 0),
			)
		}),
	)
