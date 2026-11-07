// @effect-diagnostics-next-line nodeBuiltinImport:off -- The sample exposes a localhost operator endpoint.
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import {
	Array,
	Cause,
	Deferred,
	Effect,
	FiberSet,
	FileSystem,
	Option,
	Path,
	Queue,
	Ref,
	Schema,
	Semaphore,
	String,
} from "effect"

import { Graft, Plugin, type Transition } from "@graftland/graft"
import { Include, Loader, ModuleResolver } from "@graftland/loader"
import type { ProjectionError } from "@graftland/plugin-mcp-server/Projection"
import * as Remote from "@graftland/plugin-remote"

import { consume, gateway, localBot } from "./gateway.js"

export const releases = ["v1", "v2", "broken-probe", "broken-trial"] as const
export type Release = (typeof releases)[number]
export const policy = {
	total: "30 seconds",
	startup: "2 seconds",
	probe: "200 millis",
	trial: 0,
	drain: "2 seconds",
	stop: "200 millis",
	terminate: "2 seconds",
	probes: ["health"],
} satisfies Transition.Policy

export type TransitionWrapper = (
	release: Release,
	action: Effect.Effect<Transition.Outcome, never, Graft.Graft>,
) => Effect.Effect<Transition.Outcome, ProjectionError, Graft.Graft>

export const start = Effect.fnUntraced(function* (
	directory: string,
	target: Remote.CandidateOptions["target"],
	wrapTransition: TransitionWrapper = (_, action) => action,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.makeTempDirectoryScoped({
		directory,
		prefix: "running-",
	})
	const configDirectory = path.join(root, "config")
	yield* fs.makeDirectory(configDirectory)
	const artifacts = yield* Effect.forEach(
		releases,
		Effect.fnUntraced(function* (release) {
			const source = yield* fs.realPath(
				path.join(directory, "node_modules/@example/forecasts-" + release),
			)
			const artifact = yield* Remote.Artifact.capture({
				directory: source,
				entry: "dist/index.js",
				store: path.join(root, "artifacts"),
			})
			return { release, artifact }
		}),
	)

	const artifactFor = (release: Release) =>
		Option.getOrThrow(
			Array.findFirst(artifacts, (item) => item.release === release),
		).artifact
	const input = {
		release: path.join(root, "release"),
		started: path.join(root, "started"),
	}
	const contractModule = import.meta.resolve("@example/forecast-contract")
	const initial = [
		{
			id: "forecasts",
			name: "@graftland/plugin-remote",
			config: {
				contract: "@example/forecast-contract",
				artifact: {
					...artifactFor("v1"),
					directory: path.relative(
						configDirectory,
						artifactFor("v1").directory,
					),
				},
				target,
				config: input,
				probes: ["health"],
			},
		},
	]
	const configFile = path.join(configDirectory, "graft.yml")
	const initialText = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.Json),
	)(initial)
	yield* fs.writeFileString(configFile, initialText)
	const resolver = yield* ModuleResolver.make({
		base: directory,
		importer: (specifier) => import(specifier),
	})
	yield* Graft.provide(ModuleResolver.ModuleResolver, resolver)
	const loaderReady = yield* Deferred.make<Loader.Loader["Service"]>()
	yield* Graft.plugin(
		Plugin.make({
			name: "loader-observer",
			inject: [Loader.Loader],
			apply: Effect.fnUntraced(function* () {
				const loader = yield* Loader.Loader
				yield* Deferred.succeed(loaderReady, loader)
			}),
		}),
	)
	const included = yield* Graft.plugin(Include.Include, { path: configFile })
	yield* included.await
	const loader = yield* Deferred.await(loaderReady)
	yield* loader.ready
	const upstream = yield* localBot()
	const gatewayActivations = yield* Ref.make(0)
	const consumerActivations = yield* Ref.make(0)
	const sessionReady = yield* Deferred.make<string>()
	const gatewayFork = yield* Graft.plugin(
		gateway(upstream.url, gatewayActivations),
	)
	const consumerFork = yield* Graft.plugin(
		consume(consumerActivations, sessionReady),
	)
	yield* gatewayFork.await
	yield* consumerFork.await
	const session = yield* Deferred.await(sessionReady)
	const candidate = (release: Release) =>
		Remote.candidate({
			artifact: artifactFor(release),
			target,
			contractModule,
			input,
		})
	const commands = yield* Semaphore.make(1)
	const ask = (id: string, city: string) =>
		commands.withPermit(
			upstream
				.message(id, city)
				.pipe(Effect.andThen(Queue.take(upstream.responses))),
		)
	const requests = yield* FiberSet.make<void, never>()
	yield* Effect.forkScoped(
		FiberSet.join(requests).pipe(Effect.tapCause(Effect.logError)),
	)
	const run = yield* FiberSet.runtime(requests)<Graft.Graft>()
	const operator = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createServer((request, response) => {
				if (
					request.method === "POST" &&
					request.url !== undefined &&
					String.startsWith("/message/")(request.url)
				) {
					const city = String.slice("/message/".length)(request.url)
					run(
						ask("operator", city).pipe(
							Effect.flatMap((reply) =>
								Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
									reply,
								),
							),
							Effect.matchCauseEffect({
								onFailure: (cause) =>
									Effect.sync(() => {
										response.writeHead(500)
										response.end(Cause.pretty(cause))
									}),
								onSuccess: (body) =>
									Effect.sync(() => {
										response.writeHead(200, {
											"content-type": "application/json",
										})
										response.end(body)
									}),
							}),
						),
					)
					return
				}
				const release = Array.findFirst(
					releases,
					(name) => request.url === "/upgrade/" + name,
				)
				if (request.method !== "POST" || Option.isNone(release)) {
					response.writeHead(404)
					response.end()
					return
				}
				run(
					wrapTransition(
						release.value,
						Graft.transition({
							target: "forecasts",
							candidate: candidate(release.value),
							policy: {
								...policy,
								trial: release.value === "broken-trial" ? "2 seconds" : 0,
							},
						}),
					).pipe(
						Effect.flatMap((outcome) =>
							Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
								outcome,
							),
						),
						Effect.matchCauseEffect({
							onFailure: (cause) =>
								Effect.sync(() => {
									response.writeHead(500)
									response.end(Cause.pretty(cause))
								}),
							onSuccess: (body) =>
								Effect.sync(() => {
									response.writeHead(200, {
										"content-type": "application/json",
									})
									response.end(body)
								}),
						}),
					),
				)
			}),
		),
		(server) =>
			Effect.callback<void>((resume) => {
				server.closeAllConnections()
				server.close((error) =>
					resume(error !== undefined ? Effect.die(error) : Effect.void),
				)
			}),
	)
	yield* Effect.callback<void>((resume) => {
		operator.once("error", (error) => resume(Effect.die(error)))
		operator.listen(0, "127.0.0.1", () => resume(Effect.void))
	})
	const address = operator.address() as AddressInfo
	return {
		upstream,
		session,
		gatewayActivations,
		consumerActivations,
		loader,
		configFile,
		initialText,
		artifactFor,
		input,
		candidate,
		operatorUrl: "http://127.0.0.1:" + address.port,
		ask,
	}
})
