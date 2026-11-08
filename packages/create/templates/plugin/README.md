# Graft plugin

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

A Graft plugin package. `src/index.ts` defines the plugin; `graft.yml` loads its
built `dist/index.js`.

## Run it

```sh
npm run dev
```

After editing, stop the process and run `npm run dev` again. There is no
automatic reload.

## Scripts

| Command             | Behavior                              |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Build and start                       |
| `npm test`          | Run `test/`                           |
| `npm run typecheck` | Check types and Effect diagnostics    |
| `npm run build`     | Compile `src` to the published `dist` |

Use the same scripts with pnpm or Yarn. An exact plugin package name wins;
otherwise the short name `example` tries `@graftland/plugin-example` and
`graft-plugin-example`. Name the package in full if both exist.
