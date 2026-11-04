import {
	Clock,
	Effect,
	FileSystem,
	Layer,
	Path,
	Redacted,
	Schema,
} from "effect"
import { SecureRandom, Signature } from "effect/crypto"
import { Jwk, Jwt } from "effect/jose"

export const crypto = Signature.layerWebCrypto.pipe(
	Layer.provide(SecureRandom.layerWebCrypto),
)

/** Demo credentials only: a fresh signing key and a ten-minute token. */
export const issue = Effect.fn("issue")(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const pair = yield* Jwk.generateKeyPair({ algorithm: "ES256" })
	const privateKey = yield* Jwk.importPrivate(pair.privateKey, "ES256")
	const publicKey = yield* Jwk.importPublic(pair.publicKey, "ES256")
	const pem = yield* Jwk.exportSpki(publicKey, { format: "pem" })
	const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
	const token = yield* Jwt.sign(
		Schema.Json,
		{
			iss: "https://issuer.example",
			aud: "graft",
			sub: "billing",
			exp: now + 600,
		},
		privateKey,
	)
	yield* fs.makeDirectory(directory, { recursive: true })
	const file = path.join(directory, "jwt-public.pem")
	yield* fs.writeFileString(file, pem)
	yield* fs.writeFileString(
		path.join(directory, "token"),
		Redacted.value(token),
		{
			mode: 0o600,
		},
	)
	return { publicKey: file, token: Redacted.value(token) }
})
