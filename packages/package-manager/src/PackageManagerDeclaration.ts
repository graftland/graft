import { Schema } from "effect"

export const PackageManagerName = Schema.Literals(["npm", "pnpm", "yarn"])

const CorepackHash = Schema.Union([
	Schema.Tuple([
		Schema.Literal("sha224"),
		Schema.String.check(Schema.isPattern(/^[0-9a-f]{56}$/)),
	]),
	Schema.Tuple([
		Schema.Literal("sha256"),
		Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
	]),
	Schema.Tuple([
		Schema.Literal("sha384"),
		Schema.String.check(Schema.isPattern(/^[0-9a-f]{96}$/)),
	]),
	Schema.Tuple([
		Schema.Literal("sha512"),
		Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/)),
	]),
])
const isCorepackHash = Schema.is(CorepackHash)
const Version = Schema.String.check(Schema.isMaxLength(256))
	.pipe(Schema.decodeTo(Schema.SemVerFromString))
	.check(
		Schema.makeFilter(
			(version) => version.build.length === 0 || isCorepackHash(version.build),
			{
				expected:
					"no build metadata, or a Corepack sha224/sha256/sha384/sha512 lowercase hexadecimal hash",
			},
		),
	)

/** Exact SemVer with optional prerelease and Corepack hash; ranges, URLs and arbitrary build metadata are unsupported. */
export const PackageManagerDeclaration = Schema.TemplateLiteralParser([
	PackageManagerName,
	"@",
	Version,
])
export type PackageManagerDeclaration = typeof PackageManagerDeclaration.Type
