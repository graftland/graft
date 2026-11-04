// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous Node hooks need a synchronous digest of the bytes actually loaded
import { createHash } from "node:crypto"

export const digest = (bytes: string | Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex")
