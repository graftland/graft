# Graft app

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

A Graft application. Build the source before starting; `graft.yml` selects the
captured JavaScript files.

## Run it

```sh
npm run dev
```

Edit `src/hello.ts`, then stop the process and run `npm run dev` again. The new
message appears. Editing a running application does not reload it.

## Scripts

| Command             | Behavior                           |
| ------------------- | ---------------------------------- |
| `npm run dev`       | Build and start                    |
| `npm start`         | Start the existing build           |
| `npm run build`     | Compile `src` to `dist`            |
| `npm run typecheck` | Check types and Effect diagnostics |

The `greeter` plugin publishes `Greeter`; `ticker` injects it and greets every
three seconds. The same scripts work with pnpm and Yarn.
