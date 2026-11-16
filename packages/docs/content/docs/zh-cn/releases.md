---
title: 发布
description: Graft 如何检查、打包、发布，以及如何部署文档站点。
---

每次改动都经过 CI：CI 构建唯一的包，打包一次，把同一批文件发布到 GitHub
Packages 和 npm。文档站点则另行部署到 docs.graft.land。

## 检查

所有命令都在项目的 devenv shell 中运行：

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test:packages
```

进入 shell 时 treefmt 会格式化代码。CI 也这样做，格式化改动任何文件时 CI 失败。

`pnpm test` 运行所有 vitest project。workspace
project 检查每个导出的签名都能通过包的公共导出命名。如果失败，就把实现类型从公共签名中移除，或者导出一个属于公共契约的类型。

文档检查在文档包里运行：

```sh
devenv shell -- pnpm --filter @graftland/docs test
devenv shell -- pnpm --filter @graftland/docs build
```

测试会类型检查每个代码块并运行其中的 doctest。构建会检查所有本地链接和锚点。

## 一个包

Graft 只发布 `@graftland/graft`。

| 入口        | 内容                            |
| ----------- | ------------------------------- |
| `.`         | `Graft`、`Mount` 与 `Release`。 |
| `./rpc`     | 通过 `effect/rpc` 的远程服务。  |
| `./node`    | 子进程与 worker 的 Protocol。   |
| `./testing` | 用于测试的内存中 Protocol。     |

`effect` 是 peer dependency，约束为 `4.1.*`。`@effect/platform-node`
是可选的 peer，只有 `./node` 需要它。

## 打包

`pnpm packages:pack` 构建整个 workspace，给公共包赋上引用所对应的版本，并打包到
`.release/`。`.release/release.json` 记录该版本、提交以及每个打包文件的 sha512
integrity。

只有公开（非 private）的包会被打包；在这个分支上只有 `@graftland/graft`。

| 事件                        | 版本                      | npm tag                 | 发布到                 |
| --------------------------- | ------------------------- | ----------------------- | ---------------------- |
| 推送到 `main`               | `0.0.0-commit-<完整哈希>` | `sha-<完整哈希>`        | GitHub Packages        |
| 形如 `v1.2.3-beta.0` 的 tag | `1.2.3-beta.0`            | `alpha`、`beta` 或 `rc` | GitHub Packages 与 npm |
| 形如 `v1.2.3` 的 tag        | `1.2.3`                   | `latest`                | GitHub Packages 与 npm |

tag 必须与 Changesets 提交的版本一致。不一致时打包停止，并要求你先合并 **Version
Packages** pull request。

### 安装预发布版或快照

预发布 tag 由频道名 `alpha`、`beta` 或 `rc`
加一个序号组成。它的包发布在该频道的 npm tag 下，永远不会成为 `latest`，所以
`npm install @graftland/graft` 始终安装最新的稳定版本。

| 你想要……              | 运行                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| 预发布版              | `npm install @graftland/graft@beta`                                                          |
| `main` 的任意一个提交 | `npm install @graftland/graft@0.0.0-commit-<完整哈希> --registry=https://npm.pkg.github.com` |

提交快照只发布到 GitHub Packages。安装快照时使用 workflow run 中的版本。GitHub
Packages 需要一个带 `read:packages`
的令牌，公开包也一样。首次发布到那里的包可能是私有的；在 GitHub 的包设置里设置一次可见性。

## 发布保证

### 重试

你可以在同一个 registry 队列下再次运行发布。

| 情况                   | npm                                                                          | GitHub Packages                                   |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| 已存在同版本的相同内容 | 跳过，不改动 tag。                                                           | 跳过。只要不会把频道 tag 后退，它可以修复该 tag。 |
| 已存在同版本但内容不同 | 脚本停止。                                                                   | 脚本停止。                                        |
| tag 缺失或被外部改动   | 由有 tag 权限的维护者按同样的独占发布规则单独修复。再次运行 job 不会修复它。 | 同上修复。                                        |

npm 的 trusted publisher 只有发布权限，所以重试从不调用 `npm dist-tag`。

### 频道不会后退

由于发布一次只运行一个，`latest`、`alpha`、`beta` 和 `rc` 不会退回较旧的版本。

- 首次上传和修复 GitHub tag 时，都对目标频道的当前版本使用同一套
  [SemVer 优先级](https://semver.org/#spec-item-11)比较。
- 预发布标识中的数字按数字比较（`beta.10` 比 `beta.2`
  新）。major、minor 和 patch 排在预发布序列之前。build metadata 不影响优先级。
- 脚本用显式的 `@<频道>` 选择器读取完整的 `dist-tags`
  对象，因此只有预发布版的包不需要 `latest` tag。
- 缺失的频道（E404）可以新建。只有预发布版的包还没有 `latest`；它的 tag 用
  `npm dist-tag ls` 列出，所以它的第一个稳定版本也会把 `latest`
  建起来。成功但内容为空或格式错误的响应会停止发布。
- 再次运行频道上已有的版本不会改动 tag。

### 迟到的上传

如果新上传的版本比频道当前版本旧，Graft 仍然用回退 tag 发布这个包：

| 发布类型 | 回退 tag                                           |
| -------- | -------------------------------------------------- |
| 稳定版   | `backport`                                         |
| 预发布版 | `alpha-backport`、`beta-backport` 或 `rc-backport` |

这些 tag 标记迟到的上传，不承诺跟随最新版本。安装旧版本时使用它的确切版本。再次运行一个已存在的旧版本不会移动它的频道，也不会修复回退 tag。例如，如果你先发布
`0.2.0-beta.2` 再发布 `0.2.0-beta.1`，或者之后再次运行 `beta.1`，`beta` 仍停留在
`beta.2`。

:::note

直接并发运行发布脚本没有锁，不提供频道保证。你仍然需要 registry 队列；仅靠版本比较无法让 registry 的读写变成原子操作。

:::

## 发布一个版本

1. **合并 Version Packages pull request**，让新版本进入提交。Changesets
   workflow 会打开或更新这个 pull request；它从不发布。
2. **确认 `main` 通过 CI。**
3. **给提交打 tag 并推送**，例如 `v1.2.3`。Graft 处于 0.x 期间，发布 `v0.3.0`
   这类普通版本即可：0.x 版本本身就表示 API 可能变化，不需要 `-beta` 后缀。像
   `v1.2.3-beta.0` 这样的预发布 tag 仍然可用：

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

4. **`npm` job 等待 `npm`
   environment**（如果需要审批）然后发布。`github-packages`
   job 在自己的队列下发布同一批文件。

### Trusted publishing

`npm` job 使用 npm 的
[trusted publishing](https://docs.npmjs.com/trusted-publishers)：npm 接受 workflow
run 的 OIDC 令牌而不是访问令牌，并为包添加 provenance 声明。仓库不保存任何密钥。该包信任
`graftland/graft` 中 `npm` environment 里的 `ci.yml` workflow：

```sh
npm trust github @graftland/graft --file ci.yml --repo graftland/graft --env npm --allow-publish
npm trust list @graftland/graft
```

### 第一次 trusted 发布之前

npm 只能信任已经存在的包，而已发布的 `@graftland/graft`
仍然是 0.6 版本。维护者用 CI 打包好的文件先手动上传新系列的第一个版本，之后设置 trusted
publishing：

```sh
gh run download <run id> --name packages-<commit hash> --dir .release
npm login
devenv shell -- pnpm packages:publish npm
```

上传之后，按上面的方式设置 trusted publishing。

## GitHub Actions

workflow `.github/workflows/ci.yml` 在 pull request、推送到 `main`，以及
`v1.2.3` 或 `v1.2.3-beta.0` 这类 tag 时运行。

| Job               | 何时运行           | 做什么                                                             |
| ----------------- | ------------------ | ------------------------------------------------------------------ |
| `check`           | 总是               | 检查格式、构建、类型检查、测试发布脚本并打包。                     |
| `projects`        | 总是               | 列出 vitest project，新增的 project 不必改 workflow 就有测试 job。 |
| `test`            | 总是               | 用 matrix 运行每个 vitest project。                                |
| `github-packages` | 推送与 tag         | 把打包好的文件发布到 GitHub Packages。                             |
| `npm`             | tag                | 用 trusted publishing 把打包好的文件发布到 npm。                   |
| `github-release`  | tag，在 `npm` 之后 | 用该版本的 changeset 创建 GitHub Release。                         |

`github-packages` 和 `npm` job 需要 `check` 与 `test` 都通过。它们发布的正是
`check` 打包并测试过的文件，从不重新构建。

### 发布队列

每个 registry 有一个固定的 job 并发组，`cancel-in-progress: false`，`queue: max`。

| Registry        | 并发组                    |
| --------------- | ------------------------- |
| npm             | `publish-npm`             |
| GitHub Packages | `publish-github-packages` |

- **范围。** 并发组覆盖整个发布 job：读取 tag、选择 tag、上传包以及处理重试。
- **独立。** 两个 registry 有各自的队列，可以同时发布。
- **顺序。**
  队列顺序按 job 开始等待的时间，而不是版本顺序，所以仍然需要版本比较。
- **容量。** GitHub 用 `queue: max`
  保留最多 100 个待运行 job。队列满时 GitHub 会取消多余的 job，所以要查看被取消的发布 job，并在队列清空后重新运行。

:::caution

并发组只协调本仓库的 CI
job。手动发布或修改 tag 之前，等该 registry 的所有运行中和排队中的 job 结束，并在手动操作完成前停止新的发布 job。其他发布本包的工作流必须使用同一个并发组。

:::

## 文档站点

workflow `.github/workflows/docs.yml` 在每次推送到 `main` 和每个 `v*` tag 时从
`packages/docs` 构建本站，并部署到 Cloudflare Worker 上的
[docs.graft.land](https://docs.graft.land/)。生产站点始终提供最新的稳定版本。

| Job          | 做什么                                     |
| ------------ | ------------------------------------------ |
| `plan`       | 选择要构建的提交。                         |
| `production` | 构建将成为生产站点的提交。                 |
| `build`      | 把其他保留的每个提交构建成各自的 preview。 |
| `list`       | 更新提交列表，并删除不再保留的文档。       |
| `redirect`   | 写出旧 GitHub Pages 地址的重定向。         |

最新的 15 个发布 tag 和 `main` 上最新的 30 个提交各自保留一个 Worker
Preview，地址为
`https://<哈希前 12 个字符>.<站点主机>/`。`https://versions.<站点主机>/`
提供提交列表和版本选择。旧地址 `graftland.github.io/graft` 和
`graft-docs-ekb.pages.dev` 重定向到 `docs.graft.land`。

| 任务             | 怎么做                                              |
| ---------------- | --------------------------------------------------- |
| Pages 源         | 把仓库的 Pages 源设置为 **GitHub Actions**。        |
| 本地开发文档站点 | `devenv shell -- pnpm --filter @graftland/docs dev` |

### 编写页面

| 语言     | 目录                               |
| -------- | ---------------------------------- |
| 英文     | `packages/docs/content/docs`       |
| 简体中文 | `packages/docs/content/docs/zh-cn` |
| 繁体中文 | `packages/docs/content/docs/zh-tw` |

- 每个目录使用相同的文件名。
- 页面之间用相对链接，例如 `../remote/`，这样链接在站点的 base 路径下也能工作。
- 每个英文 README 旁边都有 `README.zh-CN.md` 和 `README.zh-TW.md`
  翻译，按英文 README 编写。改动英文 README 或英文文档页面时，在同一次改动中更新翻译。
- 编写页面前先读 `packages/docs/STYLE.md`。
- 在 `packages/docs` 中运行 `node snippets.mjs check` 和
  `pnpm vitest run`，对示例做类型检查并运行其中的 doctest。

## 旧包

早期版本的 Graft 是一个分布在多个包里的插件运行时。这些包已不再开发。下表列出每个包在 npm 上发布的最后一个版本。

| 包                             | 最后一个版本 | 改用                               |
| ------------------------------ | ------------ | ---------------------------------- |
| `@graftland/loader`            | `0.6.0`      | 在你自己的程序里用 `Graft.mount`。 |
| `@graftland/cli`               | `0.6.0`      | 无；不再有命令和配置文件。         |
| `@graftland/create`            | `0.6.0`      | 无。                               |
| `@graftland/package-manager`   | `0.6.0`      | 无。                               |
| `@graftland/plugin-remote`     | `0.6.0`      | `rpc` 入口。                       |
| `@graftland/hmr`               | `0.5.0`      | 无；Graft 不再重载模块。           |
| `@graftland/plugin-http`       | `0.5.0`      | 无。                               |
| `@graftland/plugin-http-api`   | `0.5.0`      | 无。                               |
| `@graftland/plugin-mcp-server` | `0.5.0`      | 无。                               |
| `@graftland/plugin-otlp`       | `0.5.0`      | 无。                               |
| `@graftland/plugin-release`    | 未发布       | 无。                               |

`@graftland/plugin-release` 从未发布，没有对象可标记。

是否用 `npm deprecate`
标记旧包，是可选的独立决定，本页不要求这样做。它不会改变已经发布的版本。
