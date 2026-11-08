---
title: 发版
description: 添加 changeset、审核版本更新，并发布 Graft 包和发布说明。
---

Graft 使用 **Changesets**
记录面向用户的改动，准备包版本和变更日志。维护者推送匹配的版本标签后，CI 发布已通过检查的包。

## 检查

从仓库根目录通过项目的 devenv shell 执行命令：

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm vitest run --project <package>
devenv shell -- pnpm test:packages
```

进入 shell 时 treefmt 会格式化文件。运行所改包的测试；`pnpm test:packages`
检查打包、发布和发布说明。

## 添加 changeset

修改公开包的 pull request 应附带 changeset：

```sh
devenv shell -- pnpm changeset
```

| 选项       | 规则                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| 包         | 选择受影响的公开包。所有公开的 `@graftland/*` 包属于同一固定组，使用相同版本。                       |
| 版本增量   | 修复用 `patch`，功能用 `minor`；破坏性改动需注明并提供迁移步骤。0.x 阶段的破坏性改动使用次版本增量。 |
| 摘要       | 描述用户可见的行为。将 **Breaking** 改动放在最前面，说明如何迁移。                                   |
| 私有工作区 | 样例、文档和基准测试既不更新版本，也不创建标签。                                                     |
| 无公开改动 | 只修改文档或测试的 pull request 不需要 changeset。                                                   |

将生成的 `.changeset/*.md` 与改动一起提交。用
`devenv shell -- pnpm changeset status` 检查待发布的版本。

## Version Packages pull request

推送到 `graftland/graft` 的 `main` 后，`.github/workflows/release.yml`
会创建或更新 **Version
Packages**。它消费待发布的 changeset，更新包版本并生成各公开包的
`CHANGELOG.md`。先审核并合并该 pull
request，再创建标签。此工作流不发布包、不创建 GitHub
Release，也不在 fork 中运行。

在仓库的 Actions 设置中启用 **Allow GitHub Actions to create and approve pull
requests**。工作流使用 `GITHUB_TOKEN`；有写入权限的维护者需在生成的 pull
request 上选择 **Approve workflows to run**，在合并前启动检查。

## GitHub Actions

`.github/workflows/ci.yml` 在 pull request、推送到 `main` 和
`v1.2.3`、`v1.2.3-beta.0` 等版本标签时运行。

| 工作              | 时机                                 | 作用                                                      |
| ----------------- | ------------------------------------ | --------------------------------------------------------- |
| `check`           | 始终                                 | 检查格式、构建、类型检查、测试发布脚本并打包公开包。      |
| `test`            | 始终                                 | 测试所有包和样例。                                        |
| `github-packages` | 推送和标签，`check` 与 `test` 通过后 | 将已检查的文件发布到 GitHub Packages。                    |
| `npm`             | 标签，`check` 与 `test` 通过后       | 通过受信任发布将已检查的文件发布到 npm。                  |
| `github-release`  | 标签，`npm` 成功后                   | 汇总所有公开包的该版本变更日志，创建一个 GitHub Release。 |

发布直接使用 `check`
打包的文件，不再构建。发布说明去重相同条目，并标明所属包。预发布标签创建预发布 GitHub
Release。重新运行时保留已有的 GitHub Release。

### 发布队列

每个 registry 使用固定的任务并发组，设置 `cancel-in-progress: false` 和
`queue: max`。

| Registry        | 并发组                    |
| --------------- | ------------------------- |
| npm             | `publish-npm`             |
| GitHub Packages | `publish-github-packages` |

- **范围。**
  并发组覆盖整个发布任务，包括读取标签、选择标签、上传包和重试处理。不同版本对同一 registry 的这些操作不会交错。
- **独立性。** 两个 registry 使用独立队列，可以同时发布。
- **顺序。**
  队列按照任务开始等待的时间调度，并非版本顺序，因此仍然需要比较版本号。
- **容量。**
  [GitHub 并发队列](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)在
  `queue: max`
  下最多保留 100 个等待任务。队列满后，GitHub 会取消多出的任务，因此请检查 Actions 中被取消的发布任务，等队列消退后重跑。不设置
  `queue: max` 时只保留一个等待任务，第三个任务到来会替换它。

:::caution

并发组只协调本仓库的 CI 任务。手动发布或修改标签前，须等待该 registry 正在运行和排队的任务全部结束，并在手动操作完成前阻止新的发布任务进入。其他发布这些包的工作流也必须使用同一个并发组。

:::

## 版本

所有公开包共享一个已提交的版本。打包发布标签时，每个公开包的 `package.json`
版本都必须与标签一致；不一致时在打包前停止。快照版本由 commit 派生。`pnpm packages:pack`
将公开包之间的依赖固定到打包版本，把文件及其完整性哈希写入 `.release/`。

| 事件                   | 版本                       | npm 标签                | 发布到                 |
| ---------------------- | -------------------------- | ----------------------- | ---------------------- |
| 推送到 `main`          | `0.0.0-commit-<full hash>` | `sha-<full hash>`       | GitHub Packages        |
| `v1.2.3-beta.0` 类标签 | `1.2.3-beta.0`             | `alpha`、`beta` 或 `rc` | GitHub Packages 和 npm |
| `v1.2.3` 类标签        | `1.2.3`                    | `latest`                | GitHub Packages 和 npm |

### 安装预发布版本或快照

预发布标签写明渠道（`alpha`、`beta` 或
`rc`）和一个序号。它的包发布在该渠道同名的 npm 标签下，永远不会成为
`latest`，所以 `npm install @graftland/graft` 仍然安装最近的稳定版。

| 你想要……                | 运行                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| 预发布版本              | `npm install @graftland/graft@beta`                                                           |
| `main` 上的任意一次提交 | `npm install @graftland/graft@0.0.0-commit-<full hash> --registry=https://npm.pkg.github.com` |

安装提交快照时，使用工作流运行记录中的版本号。即使安装公开包，GitHub
Packages 也需要带 `read:packages`
权限的令牌。首次发布到那里的包可能是私有的，需要在 GitHub 的包设置中调整一次可见性。

## 发布保证

### 重试

发布可在同一个 registry 队列下重跑。

| 情形                 | npm                                                                              | GitHub Packages                                        |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 版本已存在且内容相同 | 跳过，不改动标签。                                                               | 跳过。只要不会把标签移向旧版本，还可以修复其渠道标签。 |
| 版本已存在但内容不同 | 脚本停止。                                                                       | 脚本停止。                                             |
| 标签缺失或被外部修改 | 需要有标签权限的维护者遵守同样的独占发布约定单独修复；重跑任务不会修复这类标签。 | 如上所述修复。                                         |

本项目的 npm 可信发布仅授权发布，所以重试不会调用 `npm dist-tag`。

### 渠道不会回退

由于发布是串行进行的，`latest`、`alpha`、`beta` 和 `rc` 都不会回退到旧版本。

- 首次上传和 GitHub 标签修复使用同一条
  [SemVer 优先级规则](https://semver.org/#spec-item-11)，与目标渠道当前指向的版本比较。
- 预发布序号按数字比较（`beta.10` 比 `beta.2`
  新）。主版本、次版本、修订号的比较优先于预发布序号。构建元数据不影响顺序。
- 脚本使用显式的 `@<channel>` 选择器读取完整 `dist-tags`
  对象，因此仅有预发布版本的包也不需要 `latest` 标签。
- 渠道缺失（E404）时可以初始化。只有预发布版本的包还没有 `latest`，此时改用
  `npm dist-tag ls` 读取它的标签，第一个正式版本同样会初始化
  `latest`。成功但为空或格式错误的响应会中止发布。
- 重跑渠道当前指向的版本不会改动标签。

### 迟到的上传

首次上传的版本若比渠道当前版本旧，包仍会发布，但使用备用标签：

| 发布类型 | 备用标签                                           |
| -------- | -------------------------------------------------- |
| 稳定版   | `backport`                                         |
| 预发布版 | `alpha-backport`、`beta-backport` 或 `rc-backport` |

这些备用标签用于标记迟到上传，不承诺指向其中最新的版本；需要旧版本时，请按完整版本号安装。重跑已存在的旧版本不会移动其渠道，也不会修复备用标签。例如先发布
`0.2.0-beta.2` 再发布 `0.2.0-beta.1`，或之后重跑 `beta.1`，`beta` 都会保留在
`beta.2`。

:::note

直接并发运行发布脚本没有锁保护，不提供上述渠道保证。仍然必须使用 registry 队列；单独的版本比较无法让 registry 的读取和写入成为原子操作。

:::

## 发布版本

1. **合并** Version Packages pull request，等待 `main` 通过 CI。
2. **标记** 该 commit，标签版本与已提交的包版本相同，然后推送标签：

   ```sh
   git tag v0.6.0
   git push origin v0.6.0
   ```

3. **检查** 标签的 CI 运行。如果 `npm` 环境需要批准，`npm`
   工作会先等待；npm 成功后，`github-release` 创建合并的 GitHub Release。

Graft 在 0.x 阶段使用 `v0.6.0` 这样的普通版本。准备 `alpha`、`beta` 或 `rc`
预发布时，使用 Changesets 的预发布模式，让清单和变更日志先包含准确的预发布版本：

```sh
devenv shell -- pnpm changeset pre enter beta
devenv shell -- pnpm changeset-version
```

审核并合并这些改动后再创建 `v0.6.0-beta.0` 标签。该系列可以发布稳定版时，运行
`devenv shell -- pnpm changeset pre exit`，让 Version
Packages 准备稳定版本。不要与自动 pull request 并行手动更新包版本。

### 可信发布

`npm`
任务使用 npm 的[可信发布](https://docs.npmjs.com/trusted-publishers)：npm 接受 workflow 运行的 OIDC 令牌，而不需要访问令牌，并为每个包附上来源证明（provenance）。仓库中不保存任何密钥。每个包都信任
`graftland/graft` 的 `ci.yml` workflow 在 `npm` 环境中的运行：

```sh
npm trust github @graftland/graft --file ci.yml --repo graftland/graft --env npm --allow-publish
npm trust list @graftland/graft
```

### 发布新包

npm 只能信任已经存在的包。因此新包要先由维护者用 CI 打包好的文件发布一次，再建立信任：

```sh
gh run download <run id> --name packages-<commit hash> --dir .release
npm login
devenv shell -- pnpm packages:publish npm
```

## 文档站

工作流 `.github/workflows/docs.yml` 从 `packages/docs`
构建本站，并部署到Cloudflare
Pages：[graft-docs-ekb.pages.dev](https://graft-docs-ekb.pages.dev/)。`main`
上的每个 commit 和每个发布 tag 都保留当时的文档。

| 地址                                                      | 内容                                                |
| --------------------------------------------------------- | --------------------------------------------------- |
| `https://graft-docs-ekb.pages.dev/`                       | **默认版本**：有文档的最新稳定 tag，例如 `v1.2.3`。 |
| `https://<hash 前 12 位>.graft-docs-ekb.pages.dev/`       | 该 commit，永久保留。                               |
| `https://versions.graft-docs-ekb.pages.dev/versions.json` | 所有已部署的 commit，及其日期、标题和 tag。         |
| `https://graftland.github.io/graft/<path>`                | 重定向到默认版本的 `<path>`。                       |

### 每次运行做什么

| 触发方式                         | 构建                                                              | 之后                                                  |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| 推送到 `main`                    | 推送的 commit。                                                   | 加入列表。                                            |
| 推送 `v1.2.3` 这样的 tag         | tag 指向的 commit，仅当它还没有文档时。                           | 给该 commit 标上 tag。更新的稳定 tag 会成为默认版本。 |
| 在 Actions 页面勾选 **backfill** | 文档站出现以来 `main` 上的每个 commit 和每个 tag 中还没有文档的。 | 加入列表。                                            |
| 在 Actions 页面填写 **rebuild**  | 填写的 commit，即使它们已有文档。                                 | 替换它们的部署并更新列表。                            |

- **每个 commit 只构建一次。**
  使用该 commit 自己的 lockfile 和工具链构建，上传后不再替换。正式地址直接提供默认版本自己的部署，所以切换默认版本不会上传任何构建。
- **默认版本。** 与 npm 一样，`v1.2.3-beta.0`
  这样的预发布版本不会成为默认版本。最后一次发布之后 `main`
  上的 commit 会出现在列表中，但不是默认版本。
- **顺序。**
  各次运行逐个更新列表。默认版本始终是有文档的最高稳定版本，晚到的运行不会让它回退。
- **失败。**
  已经无法构建的 commit 会被跳过，其他 commit 照常部署。读取线上列表失败时，运行会停止，而不是新建一份列表。
- **上限。** 一次 backfill 最多构建 256 个 commit，剩下的再运行一次。

### 切换版本

每个已部署的页面都从版本地址加载下拉框，所以在它出现之前构建的版本也有。

- **下拉框。**
  在主题选择器旁边。按从新到旧列出所有已部署的 commit，显示 tag 或短 hash，并标出默认版本。选中后打开同一页面在该版本中的地址；那时还不存在的页面会显示该版本的 404 页。
- **提示。** 其他 commit 的页面顶部会说明这一点，并链接到默认版本中的同一页面。

### 配置

| 任务                 | 方法                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare 项目      | 执行一次 `npx wrangler pages project create graft-docs --production-branch main`，再把 Cloudflare 分配的 `*.pages.dev` 名称填入工作流的 `DOCS_PAGES_HOST` 和 `DOCS_URL`。 |
| `docs` 环境的 secret | `CLOUDFLARE_API_TOKEN`（需要 **Cloudflare Pages: Edit** 权限）和 `CLOUDFLARE_ACCOUNT_ID`。                                                                                |
| 旧地址               | 将仓库的 Pages 发布源设为 **GitHub Actions**。                                                                                                                            |
| 补齐以前的文档       | 在 Actions 页面对 `main` 手动运行该工作流，并勾选 **backfill**。                                                                                                          |
| 本地开发文档站       | `devenv shell -- pnpm --filter @graftland/docs dev`；下拉框只出现在已部署的页面上。                                                                                       |

### 编写页面

| 语言     | 目录                               |
| -------- | ---------------------------------- |
| 英文     | `packages/docs/content/docs`       |
| 简体中文 | `packages/docs/content/docs/zh-cn` |
| 繁体中文 | `packages/docs/content/docs/zh-tw` |

- 每个目录中的文件名都相同。
- 页面之间使用 `../plugins/`
  这样的相对链接，以确保站点设置基础路径后链接仍然有效。
- 优先使用表格、编号步骤和简短列表，而不是长段落。每个事实只写一次，内容结束即结束。
- 每个 README 旁边都有 `README.zh-CN.md` 和 `README.zh-TW.md`
  两个译本，根据英文 README 编写。修改英文 README 或英文文档页面时，必须在同一次改动中更新译本。
