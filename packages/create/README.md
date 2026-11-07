# @graftland/create

English |
[简体中文](https://github.com/graftland/graft/blob/main/packages/create/README.zh-CN.md)
|
[繁體中文](https://github.com/graftland/graft/blob/main/packages/create/README.zh-TW.md)

Generates a new Graft project. The supported Node.js minimum is 22.19.

```sh
npm create @graftland@latest my-app
```

`npm create @graftland` runs this package's `create` command, which is also
`graft create`. It asks a few questions, each with a default; `--yes`, or a
terminal that cannot answer, takes every default. It writes one of three
templates (`app`, `plugin` or `minimal`), then installs the dependencies and
runs `git init`.

To create projects from your own program, use `create` from this package. It
asks nothing, installs nothing and does not run git:

```sh
npm install @graftland/create effect
```

```ts
yield * Create.create({ directory: "my-app", template: "plugin" })
```

## Documentation

- [Command line](https://docs.graft.land/cli/#graft-create)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).

## Package manager declarations

The shared `PackageManagerDeclaration` Schema accepts `npm`, `pnpm`, or `yarn`
followed by an exact SemVer version (at most 256 characters), including optional
prerelease identifiers. It rejects empty suffixes, leading zeros in numeric
version/prerelease components, ranges, tags, URLs, and surrounding whitespace. A
`+` suffix is reserved for a
[Corepack hash](https://github.com/nodejs/corepack#when-authoring-packages):
`sha224`, `sha256`, `sha384`, or `sha512`, followed by a dot and exactly 56, 64,
96, or 128 lowercase hexadecimal characters respectively. Arbitrary SemVer build
metadata is not supported here. Hash validation checks the declaration's syntax;
it does not download or authenticate the package-manager archive.

Both project creation and package-manager detection use this Schema, exported
from `@graftland/package-manager/PackageManagerDeclaration`. Creation preserves
the supplied declaration verbatim. An explicit detection `agent` still overrides
the manifest declaration.
