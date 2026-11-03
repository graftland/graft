---
title: 发布
description: 检查 Graft、发布到 npm 和 GitHub Packages，以及部署文档站。
---

本页面向需要检查或发布 Graft 的贡献者。

## 检查

所有命令都在项目的 devenv shell 中运行：

```sh
devenv shell -- pnpm install
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test:packages
```

进入 shell 时会通过 treefmt 格式化代码。`pnpm test:packages` 用于测试发布脚本。

CLI 构建时还会写出
`packages/cli/schema.json`，即[配置文件的 JSON Schema](../config-file/#编辑器支持)，内容来自 loader 的配置项字段和 CLI 注册的 intercept。这个文件不提交到仓库；每次发布打包的都是该次构建生成的文件。

## GitHub Actions

工作流 `.github/workflows/ci.yml` 在提交拉取请求、推送到 `main` 或推送
`v1.2.3`、`v1.2.3-beta.0` 这样的标签时运行。

| 任务              | 运行时机         | 工作内容                                                 |
| ----------------- | ---------------- | -------------------------------------------------------- |
| `check`           | 每次运行         | 检查格式、构建、类型检查、测试，并打包所有公开包。       |
| `github-packages` | 推送分支和标签时 | 将打包产物发布到 GitHub Packages。                       |
| `npm`             | 推送标签时       | 通过可信发布（trusted publishing）将打包产物发布到 npm。 |

发布任务仅在 `check` 通过后运行，发布的就是 `check`
打包并测试过的文件，不会重新构建。

每个 registry 使用固定的任务并发组（`publish-npm` 或
`publish-github-packages`），设置 `cancel-in-progress: false` 和
`queue: max`。并发组覆盖整个发布任务，包括读取标签、选择标签、上传包和重试处理，因此不同版本对同一 registry 的这些操作不会交错。两个 registry 使用独立队列，可以同时发布。

[GitHub 并发队列](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)
在 `queue: max`
下最多保留 100 个等待任务；队列满后，新到的任务会被取消，需要重跑。不设置
`queue: max` 时只保留一个等待任务，即使
`cancel-in-progress: false`，第三个任务到来仍会替换原先等待的任务。请检查 Actions 中被取消的发布任务，等队列消退后重跑。队列按照任务开始等待的时间调度，并非版本顺序，因此仍然需要比较版本号。

并发组只协调本仓库的 CI 任务。手动发布或修改标签前，须等待该 registry 正在运行和排队的任务全部结束，并在手动操作完成前阻止新的发布任务进入。其他发布这些包的工作流也必须使用同一个并发组。

## 版本

所有包使用同一个版本号一同发布。`pnpm packages:pack`
会为每个公开包设置该版本，将包之间的依赖固定到此版本，打包到 `.release/`，并在
`.release/release.json` 中记录每个文件的哈希值。

| 事件                            | 版本                       | npm 标签                | 发布目标               |
| ------------------------------- | -------------------------- | ----------------------- | ---------------------- |
| 推送到 `main`                   | `0.0.0-commit-<full hash>` | `sha-<full hash>`       | GitHub Packages        |
| 推送 `v1.2.3-beta.0` 这样的标签 | `1.2.3-beta.0`             | `alpha`、`beta` 或 `rc` | GitHub Packages 和 npm |
| 推送 `v1.2.3` 这样的标签        | `1.2.3`                    | `latest`                | GitHub Packages 和 npm |

预发布标签写明渠道（`alpha`、`beta` 或
`rc`）和一个序号。它的包发布在该渠道同名的 npm 标签下，永远不会成为
`latest`，所以 `npm install @graftland/graft`
仍然安装最近的稳定版。按渠道安装预发布版本：

```sh
npm install @graftland/graft@beta
```

提交快照可以用来试用 `main`
上的任意一次提交。使用工作流运行记录中的版本号，从 GitHub Packages 安装：

```sh
npm install @graftland/graft@0.0.0-commit-<full hash> --registry=https://npm.pkg.github.com
```

即使安装公开包，GitHub Packages 也需要带 `read:packages`
权限的令牌。首次发布到那里的包可能是私有的，需要在 GitHub 的包设置中调整一次可见性。

发布可在同一个 registry 队列下重跑。如果某个版本已经存在且内容相同，npm 发布会跳过它，保留现有标签；GitHub
Packages 还可以修复频道标签，但不会把频道移向旧版本。内容不同时，脚本会停止。本项目的 npm 可信发布仅授权发布，所以重试不会调用
`npm dist-tag`。如果 npm 标签缺失或被外部修改，需要有标签权限的维护者遵守同样的独占发布约定单独修复；重跑任务不会修复这类标签。

在上述串行发布约定下，`latest`、`alpha`、`beta` 和 `rc`
都不会回退到旧版本。首次上传和 GitHub 标签修复使用同一条
[SemVer 优先级规则](https://semver.org/#spec-item-11)，与目标频道当前指向的版本比较。脚本使用显式的
`@<channel>` 选择器读取完整 `dist-tags` 对象，因此仅有预发布版本的包也不需要
`latest`
标签。频道缺失（E404）与成功但为空或格式错误的查询响应不同，后者会中止发布。预发布序号按数字比较（`beta.10`
比 `beta.2`
新），主版本、次版本、修订号的比较优先于预发布序号，构建元数据不影响顺序。缺失的频道可以初始化；重跑频道当前指向的版本不会改动标签。

首次上传的版本若比频道当前版本旧，包仍会发布，但稳定版使用
`backport`，预发布版使用 `alpha-backport`、`beta-backport` 或
`rc-backport`。这些备用标签用于标记迟到上传，不承诺指向其中最新的版本；需要旧版本时，请按完整版本号安装。重跑已存在的旧版本不会移动频道，也不会修复备用标签。例如先发布
`0.2.0-beta.2` 再发布 `0.2.0-beta.1`，或之后重跑 `beta.1`，`beta` 都会保留在
`beta.2`。

直接并发运行发布脚本没有锁保护，不提供上述频道保证。仍然必须使用 registry 队列；单独的版本比较无法让 registry 的读取和写入成为原子操作。

## 发布版本

1. 确保 `main` 通过 CI。
2. 为提交打标签并推送，稳定版如 `v1.2.3`，预发布版如 `v1.2.3-beta.0`：

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

3. 如果 `npm` 环境配置了审批要求，`npm` 任务会等待批准，然后发布。

`npm`
任务使用 npm 的[可信发布](https://docs.npmjs.com/trusted-publishers)：npm 接受 workflow 运行的 OIDC 令牌，而不需要访问令牌，并为每个包附上来源证明（provenance）。仓库中不保存任何密钥。每个包都信任
`graftland/graft` 的 `ci.yml` workflow 在 `npm` 环境中的运行：

```sh
npm trust github @graftland/graft --file ci.yml --repo graftland/graft --env npm --allow-publish
npm trust list @graftland/graft
```

npm 只能信任已经存在的包。因此新包要先由维护者用 CI 打包好的文件发布一次，再建立信任：

```sh
gh run download <run id> --name packages-<commit hash> --dir .release
npm login
devenv shell -- pnpm packages:publish npm
```

## 文档站

工作流 `.github/workflows/docs.yml` 在每次推送到 `main` 时，从 `packages/docs`
构建本站，并部署到 GitHub
Pages：[graftland.github.io/graft](https://graftland.github.io/graft/)。也可以从 Actions 页面手动触发。同一时间只会进行一次部署。

仓库的 Pages 发布源必须设为 **GitHub Actions**。本地开发文档站时，运行：

```sh
devenv shell -- pnpm --filter @graftland/docs dev
```

英文页面位于 `packages/docs/content/docs`，简体中文页面位于其中的 `zh-cn`
目录，繁体中文页面位于其中的 `zh-tw` 目录，文件名都与英文一致。页面之间使用
`../plugins/` 这样的相对链接，以确保站点设置基础路径后链接仍然有效。

每个 README 旁边都有 `README.zh-CN.md` 和 `README.zh-TW.md`
两个译本，根据英文 README 编写。修改英文 README 或英文文档页面时，必须在同一次改动中更新译本。
