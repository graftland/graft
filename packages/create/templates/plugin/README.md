# Graft plugin

A [Graft](https://github.com/graftland/graft) plugin package. `src/index.ts`
defines the plugin, and `graft.yml` loads it for local runs.

| Script              | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | Runs the plugin from `graft.yml` and reloads it as files change |
| `npm test`          | Runs the tests in `test/`                                       |
| `npm run typecheck` | Checks types, including Effect diagnostics                      |
| `npm run build`     | Compiles `src` to `dist`, which is what the package publishes   |

Use the same scripts with pnpm (`pnpm dev`) or Yarn (`yarn dev`).

Graft resolves the short name `example` to `@graftland/plugin-example` or
`graft-plugin-example`. Packages named otherwise must be listed in `graft.yml`
by their full name.
