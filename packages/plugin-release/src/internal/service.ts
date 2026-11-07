import {
	Array,
	Cause,
	Clock,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Option,
	Path,
	Record,
	Ref,
	Schema,
	Semaphore,
	Stream,
} from "effect"

import { Graft, Manifest, Transition, Trust } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import * as Remote from "@graftland/plugin-remote"
import * as Policy from "@graftland/plugin-remote/Policy"

import {
	Journal,
	ReleaseError,
	Releases,
	summarize,
	type Apply,
	type Diagnostic,
	type Entry,
	type Options,
} from "../Model"
import { changes } from "./changes"
import { execute as executeEntries } from "./execution"
import { validate } from "./journal"
import {
	build,
	durable,
	equal,
	failure,
	load,
	protect,
	read,
	resolveInput,
} from "./storage"

export const make = Effect.fnUntraced(function* (options: Options) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const resolver = yield* ModuleResolver.ModuleResolver
	const scope = yield* Effect.scope
	const environment = yield* Effect.context<
		| Effect.Services<ReturnType<typeof build>>
		| Graft.Graft
		| import("effect").Scope.Scope
	>()
	const store = path.resolve(options.store)
	yield* fs.makeDirectory(store, { recursive: true })
	const journalFile = path.join(store, "journal.json")
	const saved = (yield* fs.exists(journalFile))
		? yield* read(journalFile, Journal)
		: undefined
	const recovered =
		saved === undefined ? undefined : yield* validate(store, saved)
	const initial = recovered?.status.current ?? options.initial
	const governed = options.trust !== undefined
	const policy =
		options.trust === undefined
			? undefined
			: yield* read(options.trust, Policy.Policy)
	const initialRelease = yield* load(store, initial, governed)
	const state = yield* Ref.make<Journal>(
		saved ?? {
			version: 1,
			status: {
				current: initial,
				previous: null,
				state: "Ready",
				revocations: initialRelease.revocations,
			},
			events: [],
		},
	)
	const lock = yield* Semaphore.make(1)
	const journalLock = yield* Semaphore.make(1)
	// The journal belongs to this owner: callbacks such as projection audit run
	// in callers' contexts, which need not carry platform services.
	const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
	const persist = (modify: (journal: Journal) => Journal) =>
		journalLock.withPermit(
			Effect.gen(function* () {
				const previous = yield* Ref.get(state)
				const next = modify(previous)
				yield* durable(journalFile, next).pipe(Effect.provideContext(platform))
				yield* Ref.set(state, next)
			}).pipe(Effect.uninterruptible),
		)
	const ready = yield* Deferred.make<void, Trust.RegistrationError>()
	yield* Effect.addFinalizer(() =>
		Deferred.fail(
			ready,
			Trust.RegistrationError.make({
				message: "Release owner closed before audit became available",
			}),
		),
	)
	const authority =
		policy === undefined
			? undefined
			: yield* Policy.install(
					policy,
					recovered?.approvals ?? [],
					saved?.status.revocations ?? initialRelease.revocations,
					recovered?.publications ?? [],
				).pipe(
					Effect.provideService(Policy.Audit, {
						ready: Deferred.await(ready),
						record: (projection) =>
							Effect.gen(function* () {
								const at = yield* Clock.currentTimeMillis
								yield* persist((journal) => ({
									...journal,
									events: [
										...journal.events,
										{
											kind: "Projection",
											current: journal.status.current,
											target: journal.status.current,
											at,
											projection,
										},
									],
								})).pipe(
									Effect.mapError((error) =>
										Trust.RegistrationError.make({
											message: "Could not record projection revision",
											cause: Cause.fail(error),
										}),
									),
								)
							}),
					}),
				)
	const event = (
		kind: import("../Model").Event["kind"],
		target: string,
		entry?: string,
		outcome?: Transition.Outcome,
	) =>
		Ref.get(state).pipe(
			Effect.flatMap((journal) =>
				persist((latest) => ({
					...journal,
					events: [
						...latest.events,
						{
							kind,
							current: journal.status.current,
							target,
							...(entry === undefined ? {} : { entry }),
							...(outcome === undefined ? {} : { outcome: summarize(outcome) }),
						},
					],
				})),
			),
		)
	const contract = Effect.fnUntraced(function* (entry: Entry) {
		const observationScope = yield* Effect.scope
		const module = yield* resolver.importModule(entry.contract, {
			observationScope,
		})
		const found = Remote.Contract.fromModule(module)
		if (Option.isNone(found))
			return yield* failure("Contract", "No contract exported for " + entry.id)
		return found.value
	})
	const prepared = Effect.fnUntraced(function* (entry: Entry) {
		const declaration = yield* contract(entry)
		if (governed && hasEnvironmentReference(entry.input))
			return yield* failure(
				"Secrets",
				"Governed inputs must not resolve environment values; use host capability credential references",
			)
		const input = governed ? entry.input : yield* resolveInput(entry.input)
		// Decoded values never enter release files, plans, or the durable journal.
		yield* Schema.decodeEffect(declaration.config)(input).pipe(
			Effect.mapError((cause) => importError(entry.id, cause)),
		)
		return { declaration, input }
	})
	const candidate = Effect.fnUntraced(function* (id: string, entry: Entry) {
		const { input } = yield* prepared(entry)
		return Remote.candidate({
			artifact: {
				...entry.artifact,
				directory: path.join(store, id, entry.artifact.directory),
			},
			contractModule: entry.contract,
			target: entry.target,
			input,
		})
	}, Effect.scoped)
	const inspect = Effect.fnUntraced(function* (target: string) {
		const journal = yield* Ref.get(state)
		const current = yield* load(store, journal.status.current, governed)
		const next = yield* load(store, target, governed)
		const selections = Array.map(next.entries, (entry) => ({
			id: entry.id,
			package: entry.package,
			entry: entry.entry,
		}))
		const inspections = yield* Effect.forEach(
			next.entries,
			Effect.fnUntraced(function* (entry) {
				const before = Array.findFirst(
					current.entries,
					(old) => old.id === entry.id,
				)
				const deployment: ReadonlyArray<Diagnostic> = Option.isNone(before)
					? [
							{
								entry: entry.id,
								code: "Membership",
								message: "Live additions require application restart",
							},
						]
					: before.value.contract !== entry.contract ||
						  !(yield* equal(before.value.target, entry.target))
						? [
								{
									entry: entry.id,
									code: "Deployment",
									message:
										"Contract or placement changes require application restart",
								},
							]
						: []
				const compatibility = Array.filter(
					Manifest.check(
						{ ...options.host, placement: entry.target._tag },
						selections,
					),
					(item) => item.entry === entry.id || item.entry === "host",
				)
				const decoded = yield* prepared(entry).pipe(Effect.exit)
				if (decoded._tag === "Failure") {
					if (Cause.hasInterrupts(decoded.cause))
						return yield* Effect.failCause(decoded.cause)
					return [
						...deployment,
						...compatibility,
						{
							entry: entry.id,
							code: "Configuration",
							message:
								"Configuration or its references cannot be decoded for " +
								entry.id,
							cause: decoded.cause,
						},
					]
				}
				const declaration = decoded.value.declaration
				const declared = Manifest.getEntry(entry.package.graft, entry.entry)
				const missing = Array.filter(declaration.provides, (service) => {
					const operations = Array.map(service.operations, Manifest.operationId)
					return (
						declared === undefined ||
						!Array.some(
							declared.services.implements,
							(binding) =>
								binding.key === service.key.key &&
								Array.every(operations, (identity) =>
									Array.contains(binding.operations, identity),
								),
						)
					)
				})
				const contracts = Array.map(missing, (service): Diagnostic => ({
					entry: entry.id,
					code: "Contract",
					message:
						"Implementation does not provide the configured service binding " +
						service.key.key,
				}))
				const placement: ReadonlyArray<Diagnostic> =
					!Array.every(
						declaration.inject,
						(service) => service.key.key === Remote.Capabilities.Broker.key,
					) || !Array.every(declaration.provides, (service) => service.unary)
						? [
								{
									entry: entry.id,
									code: "Placement",
									message:
										"Managed direct releases require unary contracts with only host capability injection",
								},
							]
						: []
				return [...deployment, ...compatibility, ...contracts, ...placement]
			}, Effect.scoped),
		)
		const removed = Array.map(
			Array.filter(
				current.entries,
				(old) => !Array.some(next.entries, (entry) => entry.id === old.id),
			),
			(old): Diagnostic => ({
				entry: old.id,
				code: "Membership",
				message: "Live removals require application restart",
			}),
		)
		const grantReferences =
			policy === undefined
				? []
				: Array.flatMap(next.entries, (entry) =>
						Array.flatMap(
							Array.filter(
								policy.entries,
								(assignment: Policy.Assignment) =>
									assignment.entry === entry.id &&
									assignment.artifact.package === entry.package.name &&
									assignment.artifact.digest === entry.artifact.identity.digest,
							),
							(assignment: Policy.Assignment) =>
								Array.flatMap(assignment.grants, (grant) =>
									grant._tag === "Http" && grant.credential !== undefined
										? [grant.id, "env:" + grant.credential]
										: [grant.id],
								),
						),
					)
		const revoked = Array.map(
			Array.filter(
				Array.dedupe([...next.references, ...grantReferences]),
				(reference) =>
					Array.contains(
						[...journal.status.revocations, ...next.revocations],
						reference,
					),
			),
			(reference): Diagnostic => ({
				entry: "release",
				code: "Revoked",
				reference,
				message: "Release restores revoked reference " + reference,
			}),
		)
		return {
			current: journal.status.current,
			target,
			changes: yield* changes(current, next),
			diagnostics: [...Array.flatten(inspections), ...removed, ...revoked],
		}
	})
	const startupPlan = yield* inspect(initial)
	const acceptedOverride = recovered?.override === true
	const assignmentEquals = Schema.toEquivalence(Policy.Assignment)
	const restoredGrantOverrides = Array.flatMap(
		recovered?.approvals ?? [],
		(approval) =>
			approval.overrideRevocations &&
			approval.statement.policyVersion === policy?.version &&
			Array.some(policy?.entries ?? [], (entry) =>
				assignmentEquals(entry, approval.statement.assignment),
			)
				? Array.flatMap(approval.statement.assignment.grants, (grant) =>
						grant._tag === "Http" && grant.credential !== undefined
							? [grant.id, "env:" + grant.credential]
							: [grant.id],
					)
				: [],
	)
	const startupDiagnostics = Array.filter(
		startupPlan.diagnostics,
		(item) =>
			item.code !== "Revoked" ||
			!(
				acceptedOverride ||
				(item.reference !== undefined &&
					!Array.contains(initialRelease.references, item.reference) &&
					Array.contains(restoredGrantOverrides, item.reference))
			),
	)
	if (startupDiagnostics.length > 0) return yield* planError(startupDiagnostics)
	const forks = yield* Effect.forEach(
		initialRelease.entries,
		Effect.fnUntraced(function* (entry) {
			const { declaration, input } = yield* prepared(entry)
			const fork = yield* Graft.plugin(
				Remote.plugin(declaration, {
					instance: entry.id,
					artifact: {
						...entry.artifact,
						directory: path.join(store, initial, entry.artifact.directory),
					},
					contractModule: entry.contract,
					target: entry.target,
					policy: {
						trial: "2 seconds",
						...options.policy,
						probes: entry.probes,
					},
				}),
				input,
			).pipe(
				(effect) =>
					authority === undefined
						? effect
						: Effect.provideService(effect, Policy.Service, authority),
				Effect.provideService(
					Transition.CurrentInstance,
					Option.some(entry.id),
				),
			)
			yield* fork.await
			return { id: entry.id, fork }
		}),
	)
	const generations = Effect.forEach(
		forks,
		Effect.fnUntraced(function* ({ id, fork }) {
			const snapshot = yield* Stream.runHead(fork.generations)
			return {
				id,
				attempt: Option.isSome(snapshot)
					? Array.findFirst(
							snapshot.value,
							(generation) => generation.state === "Serving",
						).pipe(
							Option.map((generation) => generation.attempt),
							Option.getOrElse(() => -1),
						)
					: -1,
			}
		}),
	)
	const initialGenerations = yield* generations
	const known = yield* Ref.make(initialGenerations)
	const plan = Effect.fnUntraced(function* (target: string) {
		const result = yield* inspect(target)
		const expected = yield* Ref.get(known)
		const actual = yield* generations
		return (yield* equal(expected, actual))
			? result
			: {
					...result,
					diagnostics: [
						...result.diagnostics,
						{
							entry: "release",
							code: "ExternalChange",
							message:
								"Managed generations changed outside Releases; restart from the accepted release",
						},
					],
				}
	})
	yield* Ref.update(state, (journal) => ({
		...journal,
		status: { ...journal.status, state: "Ready" as const },
	}))
	yield* event(saved === undefined ? "Bootstrap" : "Startup", initial)
	yield* Deferred.succeed(ready, undefined)
	const execute = Effect.fnUntraced(function* (request: Apply) {
		const journal = yield* Ref.get(state)
		if (journal.status.current !== request.expected)
			return yield* failure(
				"Conflict",
				"Expected current release does not match",
			)
		if (journal.status.state !== "Ready")
			return yield* failure(
				"Degraded",
				"Restart from the last accepted release before applying again",
			)
		const planned = yield* plan(request.target)
		const diagnostics = Array.filter(
			planned.diagnostics,
			(diagnostic) =>
				diagnostic.code !== "Revoked" || request.overrideRevocations !== true,
		)
		if (diagnostics.length > 0) return yield* planError(diagnostics)
		if (request.target === journal.status.current)
			return { status: journal.status, outcomes: [] }
		const previous = yield* load(store, journal.status.current, governed)
		const next = yield* load(store, request.target, governed)
		// Prepare all in-memory recovery inputs before admitting any transition.
		const work = yield* Effect.forEach(
			planned.changes,
			Effect.fnUntraced(function* (change) {
				const old = Option.getOrThrow(
					Array.findFirst(
						previous.entries,
						(entry) => entry.id === change.entry,
					),
				)
				const target = Option.getOrThrow(
					Array.findFirst(next.entries, (entry) => entry.id === change.entry),
				)
				return {
					old,
					target,
					before: yield* candidate(journal.status.current, old),
					after: yield* candidate(request.target, target),
				}
			}),
		)
		yield* persist((latest) => ({
			...journal,
			status: { ...journal.status, state: "Applying" },
			events: [
				...latest.events,
				{
					kind: "Intent",
					entries: Array.map(work, (item) => item.target.id),
					current: journal.status.current,
					target: request.target,
					overrideRevocations: request.overrideRevocations === true,
				},
			],
		}))
		const progress = yield* executeEntries(
			work,
			(item) => item.target.id,
			Effect.fnUntraced(function* (item, compensation) {
				const entry = compensation ? item.old : item.target
				const outcome = yield* Graft.transition({
					target: entry.id,
					candidate: compensation ? item.before : item.after,
					policy: {
						trial: "2 seconds",
						...options.policy,
						probes: entry.probes,
					},
				})
				yield* event(
					compensation ? "Compensation" : "Outcome",
					compensation ? journal.status.current : request.target,
					entry.id,
					outcome,
				)
				return outcome
			}),
		)
		const finished = yield* Ref.get(state)
		const status: import("../Model").Status =
			progress._tag === "Rejected"
				? { ...journal.status, state: progress.degraded ? "Degraded" : "Ready" }
				: {
						current: request.target,
						previous: journal.status.current,
						state: "Ready",
						revocations: Array.dedupe([
							...journal.status.revocations,
							...next.revocations,
						]),
					}
		yield* persist((latest) => ({
			...finished,
			status,
			events: [
				...latest.events,
				{
					kind: progress._tag === "Rejected" ? "Rejected" : "Commit",
					current: status.current,
					target: request.target,
					overrideRevocations: request.overrideRevocations === true,
				},
			],
		}))
		if (progress._tag !== "Rejected" && authority !== undefined)
			yield* authority.revoke(
				Array.filter(
					status.revocations,
					(ref) => !Array.contains(journal.status.revocations, ref),
				),
			)
		const finalGenerations = yield* generations
		yield* Ref.set(known, finalGenerations)
		return { status, outcomes: progress.outcomes }
	})
	const owned = <A, E>(
		effect: Effect.Effect<
			A,
			E,
			| Graft.Graft
			| FileSystem.FileSystem
			| Path.Path
			| import("effect").Scope.Scope
		>,
	) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.forkIn(
				lock
					.withPermit(
						effect.pipe(
							Effect.catchCause((cause) =>
								Effect.gen(function* () {
									const journal = yield* Ref.get(state)
									if (journal.status.state !== "Applying")
										return yield* Effect.failCause(cause)
									const degraded: Journal = {
										...journal,
										status: { ...journal.status, state: "Degraded" },
									}
									yield* Ref.update(state, (current) => ({
										...current,
										status: { ...current.status, state: "Degraded" as const },
									}))
									const persisted = yield* Effect.exit(
										persist((latest) => ({
											...degraded,
											events: latest.events,
										})),
									)
									return yield* Effect.failCause(
										persisted._tag === "Failure"
											? Cause.combine(cause, persisted.cause)
											: cause,
									)
								}),
							),
						),
					)
					.pipe(Effect.provideContext(environment)),
				scope,
			).pipe(Effect.flatMap((fiber) => restore(Fiber.join(fiber)))),
		)
	return Releases.of({
		approvals: authority?.statements ?? Effect.succeed([]),
		approve: (request) =>
			Effect.gen(function* () {
				if (authority === undefined)
					return yield* Policy.PolicyError.make({
						message: "No operator policy is installed",
					})
				const approval = yield* authority.review(request)
				const journal = yield* Ref.get(state)
				yield* persist((latest) => ({
					...journal,
					events: [
						...latest.events,
						{
							kind: "Approval",
							current: journal.status.current,
							target: journal.status.current,
							approval,
						},
					],
				}))
				yield* authority.approve(approval)
				return approval
			}).pipe(owned, protect),
		revoke: (references, who) =>
			Effect.gen(function* () {
				if (who.length === 0)
					return yield* failure("Approval", "An operator identity is required")
				const journal = yield* Ref.get(state)
				const at = yield* Clock.currentTimeMillis
				yield* persist((latest) => ({
					...journal,
					status: {
						...journal.status,
						revocations: Array.dedupe([
							...journal.status.revocations,
							...references,
						]),
					},
					events: [
						...latest.events,
						{
							kind: "Revocation",
							current: journal.status.current,
							target: journal.status.current,
							revocations: references,
							who,
							at,
						},
					],
				}))
				if (authority !== undefined) yield* authority.revoke(references)
			}).pipe(owned, protect),
		build: (request) =>
			protect(
				Ref.get(state).pipe(
					Effect.flatMap((journal) =>
						build(
							store,
							{
								...request,
								metadataOnly: governed || request.metadataOnly === true,
							},
							journal.status.revocations,
						),
					),
					Effect.provideContext(environment),
				),
			),
		plan: (target) =>
			protect(
				lock.withPermit(plan(target)).pipe(Effect.provideContext(environment)),
			),
		apply: (request) => execute(request).pipe(owned, protect),
		rollback: (expected, overrideRevocations) =>
			Effect.gen(function* () {
				const journal = yield* Ref.get(state)
				if (journal.status.previous === null)
					return yield* failure("Previous", "No previous accepted release")
				return yield* execute({
					target: journal.status.previous,
					expected,
					...(overrideRevocations === undefined ? {} : { overrideRevocations }),
				})
			}).pipe(owned, protect),
		observe: Ref.get(state).pipe(Effect.map((journal) => journal.status)),
		history: Ref.get(state).pipe(Effect.map((journal) => journal.events)),
	})
}, protect)

const importError = (entry: string, cause: Schema.SchemaError) =>
	importReleaseError(entry, Cause.fail(cause))

const importReleaseError = (entry: string, cause: Cause.Cause<unknown>) =>
	ReleaseError.make({
		code: "Configuration",
		message: "Invalid configuration for " + entry,
		cause,
	})

const planError = (diagnostics: ReadonlyArray<Diagnostic>) =>
	ReleaseError.make({
		code: "Plan",
		message: "Release plan has diagnostics; inspect plan before applying",
		cause: Array.reduce<Diagnostic, Cause.Cause<unknown>>(
			diagnostics,
			Cause.empty,
			(cause, diagnostic) =>
				Cause.combine(cause, diagnostic.cause ?? Cause.empty),
		),
	})

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
	Array.isArray(value)
const hasEnvironmentReference = (value: Schema.Json): boolean =>
	isJsonArray(value)
		? Array.some(value, hasEnvironmentReference)
		: value !== null && typeof value === "object"
			? "$env" in value ||
				Array.some(Record.values(value), hasEnvironmentReference)
			: false
