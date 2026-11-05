import {
	Array,
	DateTime,
	Effect,
	FileSystem,
	Path,
	Redacted,
	Result,
	Schema,
	String,
} from "effect"
import { SecureRandom, WebCrypto } from "effect/crypto"
import { Base64 } from "effect/encoding"
import { NetAddress } from "effect/net"

import * as asn1js from "asn1js"
import * as pki from "pkijs"

export class CertificateError extends Schema.TaggedError<
	CertificateError,
	{ readonly brand: unique symbol }
>()("CertificateError", {
	detail: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		return this.detail
	}
}

/** A requested output already exists and replacing it was not asked for. */
export class CertificateExists extends Schema.TaggedError<
	CertificateExists,
	{ readonly brand: unique symbol }
>()("CertificateExists", { file: Schema.String }) {
	override get message() {
		return `${this.file} already exists; use --force to replace the requested certificates`
	}
}

/** Only PEM leaves this boundary; PKI.js objects stay local to each operation. */
export interface Pem {
	readonly certificate: string
	readonly privateKey: Redacted.Redacted<string>
}
export interface IssueOptions {
	readonly name: string
	readonly days: number
	readonly usage: "ca" | "server" | "client"
	readonly hosts?: ReadonlyArray<string>
	readonly identities?: ReadonlyArray<string>
	readonly issuer?: Pem
}
const pem = (label: string, bytes: ArrayBuffer) =>
	`-----BEGIN ${label}-----\n${String.replace(/.{64}(?=.)/g, "$&\n")(Base64.encode(new Uint8Array(bytes)))}\n-----END ${label}-----\n`
// WebCrypto and PKI.js take ArrayBuffer-backed bytes, so the decoded view is copied into one.
const der = (value: string) =>
	Effect.fromResult(
		Base64.decode(String.replace(/-----[^-]+-----|\s/g, "")(value)),
	).pipe(Effect.map((bytes) => new Uint8Array(bytes)))
const subject = (name: string) =>
	new pki.RelativeDistinguishedNames({
		typesAndValues: [
			new pki.AttributeTypeAndValue({
				type: "2.5.4.3",
				value: new asn1js.Utf8String({ value: name }),
			}),
		],
	})
const hostName = (host: string) =>
	Result.match(NetAddress.ipFromString(host), {
		onFailure: () => new pki.GeneralName({ type: 2, value: host }),
		onSuccess: (ip) =>
			new pki.GeneralName({
				type: 7,
				value: new asn1js.OctetString({
					valueHex: new Uint8Array(
						ip._tag === "Ipv4Address"
							? NetAddress.ipv4ToOctets(ip)
							: NetAddress.ipv6ToOctets(ip),
					),
				}),
			}),
	})

export const issue = Effect.fn("Certificates.issue")(function* (
	options: IssueOptions,
) {
	const random = yield* SecureRandom.SecureRandom
	const serial = yield* random.randomBytes(19)
	const now = yield* DateTime.now
	const webcrypto = yield* WebCrypto.WebCrypto
	const engine = new pki.CryptoEngine({
		name: "Node WebCrypto",
		crypto: webcrypto,
	})
	const failure = (cause: unknown) =>
		CertificateError.make({
			detail: `Could not issue the certificate for ${options.name}`,
			cause,
		})
	const keys = yield* Effect.tryPromise({
		try: () =>
			webcrypto.subtle.generateKey(
				{ name: "ECDSA", namedCurve: "P-256" },
				true,
				["sign", "verify"],
			),
		catch: failure,
	})
	// Reused CA keys have the same P-256 / PKCS#8 format as the ones this command creates.
	const authority =
		options.issuer === undefined
			? undefined
			: {
					certificate: yield* Effect.mapError(
						der(options.issuer.certificate),
						failure,
					),
					privateKey: yield* Effect.mapError(
						der(Redacted.value(options.issuer.privateKey)),
						failure,
					),
				}
	const signingKey =
		authority === undefined
			? keys.privateKey
			: yield* Effect.tryPromise({
					try: () =>
						webcrypto.subtle.importKey(
							"pkcs8",
							authority.privateKey,
							{ name: "ECDSA", namedCurve: "P-256" },
							false,
							["sign"],
						),
					catch: failure,
				})
	const certificate = yield* Effect.try({
		try: () => {
			const issuer =
				authority === undefined
					? undefined
					: pki.Certificate.fromBER(authority.certificate)
			const names = [
				...Array.map(options.hosts ?? [], hostName),
				...Array.map(
					options.identities ?? [],
					(identity) =>
						new pki.GeneralName({ type: 6, value: `graft://${identity}` }),
				),
			]
			return new pki.Certificate({
				version: 2,
				// A leading nonzero byte keeps the serial positive without losing random bits.
				serialNumber: new asn1js.Integer({
					valueHex: new Uint8Array([1, ...serial]),
				}),
				subject: subject(options.name),
				issuer: issuer?.subject ?? subject(options.name),
				notBefore: new pki.Time({ value: DateTime.toDateUtc(now) }),
				notAfter: new pki.Time({
					value: DateTime.toDateUtc(DateTime.add(now, { days: options.days })),
				}),
				extensions: [
					new pki.Extension({
						extnID: "2.5.29.19",
						critical: true,
						extnValue: new pki.BasicConstraints({ cA: options.usage === "ca" })
							.toSchema()
							.toBER(),
					}),
					new pki.Extension({
						extnID: "2.5.29.15",
						critical: true,
						extnValue: new asn1js.BitString({
							valueHex: new Uint8Array([options.usage === "ca" ? 0x06 : 0x80]),
						}).toBER(),
					}),
					...(options.usage === "ca"
						? []
						: [
								new pki.Extension({
									extnID: "2.5.29.37",
									extnValue: new pki.ExtKeyUsage({
										keyPurposes: [
											options.usage === "server"
												? "1.3.6.1.5.5.7.3.1"
												: "1.3.6.1.5.5.7.3.2",
										],
									})
										.toSchema()
										.toBER(),
								}),
							]),
					...(names.length === 0
						? []
						: [
								new pki.Extension({
									extnID: "2.5.29.17",
									extnValue: new pki.AltName({ altNames: names })
										.toSchema()
										.toBER(),
								}),
							]),
				],
			})
		},
		catch: failure,
	})
	yield* Effect.tryPromise({
		try: () =>
			certificate.subjectPublicKeyInfo.importKey(keys.publicKey, engine),
		catch: failure,
	})
	yield* Effect.tryPromise({
		try: () => certificate.sign(signingKey, "SHA-256", engine),
		catch: failure,
	})
	const privateKey = yield* Effect.tryPromise({
		try: () => webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
		catch: failure,
	})
	return yield* Effect.try({
		try: () => ({
			certificate: pem("CERTIFICATE", certificate.toSchema().toBER()),
			privateKey: Redacted.make(pem("PRIVATE KEY", privateKey)),
		}),
		catch: failure,
	})
})

export const read = Effect.fn("Certificates.read")(function* (base: string) {
	const fs = yield* FileSystem.FileSystem
	const certificate = yield* fs.readFileString(base + ".crt")
	const privateKey = yield* fs.readFileString(base + ".key")
	return { certificate, privateKey: Redacted.make(privateKey) }
})
export const write = Effect.fn("Certificates.write")(function* (
	base: string,
	pair: Pem,
	force: boolean = false,
) {
	const fs = yield* FileSystem.FileSystem
	yield* fs.writeFileString(base + ".key", Redacted.value(pair.privateKey), {
		flag: force ? "w" : "wx",
		mode: 0o600,
	})
	// Opening an existing file does not change its permissions when renewing it.
	yield* fs.chmod(base + ".key", 0o600)
	yield* fs.writeFileString(base + ".crt", pair.certificate, {
		flag: force ? "w" : "wx",
	})
	// One region for the pair: an interruption between the files would leave a key without its certificate.
}, Effect.uninterruptible)

export interface Options {
	readonly out: string
	readonly server: ReadonlyArray<string>
	readonly identity: ReadonlyArray<string>
	readonly days: number
	readonly force: boolean
}
/** URI-encode names so each identity has a distinct filename, including names with slashes. */
export const clientName = (identity: string) =>
	`client-${encodeURIComponent(identity)}`
export const generate = Effect.fn("Certificates.generate")(function* (
	options: Options,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const outputs = [
		...(options.server.length === 0 ? [] : ["server"]),
		...Array.map(Array.dedupe(options.identity), clientName),
	]
	if (!options.force) {
		const files = Array.flatMap(outputs, (name) =>
			Array.map([".crt", ".key"], (extension) =>
				path.join(options.out, name + extension),
			),
		)
		const taken = yield* Effect.filter(files, fs.exists)
		if (Array.isReadonlyArrayNonEmpty(taken))
			return yield* CertificateExists.make({ file: taken[0] })
	}
	yield* fs
		.makeDirectory(options.out, { recursive: true })
		.pipe(Effect.uninterruptible)
	const ca = path.join(options.out, "ca")
	const existing =
		(yield* fs.exists(ca + ".crt")) || (yield* fs.exists(ca + ".key"))
	// An incomplete CA pair fails on read. Even --force never replaces the signing authority.
	const issuer = existing
		? yield* read(ca)
		: yield* issue({ name: "Graft CA", usage: "ca", days: options.days }).pipe(
				Effect.tap((pair) => write(ca, pair)),
			)
	if (options.server.length > 0) {
		const pair = yield* issue({
			name: "Graft runner",
			usage: "server",
			hosts: options.server,
			days: options.days,
			issuer,
		})
		yield* write(path.join(options.out, "server"), pair, options.force)
	}
	yield* Effect.forEach(
		Array.dedupe(options.identity),
		(identity) =>
			issue({
				name: identity,
				usage: "client",
				identities: [identity],
				days: options.days,
				issuer,
			}).pipe(
				Effect.flatMap((pair) =>
					write(
						path.join(options.out, clientName(identity)),
						pair,
						options.force,
					),
				),
			),
		{ discard: true },
	)
})
