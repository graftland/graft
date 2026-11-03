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

## GitHub Actions

工作流 `.github/workflows/ci.yml` 在提交拉取请求、推送到 `main` 或推送 `v1.2.3`
这样的标签时运行。

| 任务              | 运行时机         | 工作内容                                             |
| ----------------- | ---------------- | ---------------------------------------------------- |
| `check`           | 每次运行         | 检查格式、构建、类型检查、测试，并打包所有公开包。   |
| `github-packages` | 推送分支和标签时 | 将打包产物发布到 GitHub Packages。                   |
| `npm`             | 推送标签时       | 将打包产物发布到 npm，并附带来源证明（provenance）。 |

发布任务仅在 `check` 通过后运行，发布的就是 `check`
打包并测试过的文件，不会重新构建。

## 版本

所有包使用同一个版本号一同发布。`pnpm packages:pack`
会为每个公开包设置该版本，将包之间的依赖固定到此版本，打包到 `.release/`，并在
`.release/release.json` 中记录每个文件的哈希值。

| 事件                     | 版本                       | npm 标签          | 发布目标               |
| ------------------------ | -------------------------- | ----------------- | ---------------------- |
| 推送到 `main`            | `0.0.0-commit-<full hash>` | `sha-<full hash>` | GitHub Packages        |
| 推送 `v1.2.3` 这样的标签 | `1.2.3`                    | `latest`          | GitHub Packages 和 npm |

提交快照可以用来试用 `main`
上的任意一次提交。使用工作流运行记录中的版本号，从 GitHub Packages 安装：

```sh
npm install @graftland/graft@0.0.0-commit-<full hash> --registry=https://npm.pkg.github.com
```

即使安装公开包，GitHub Packages 也需要带 `read:packages`
权限的令牌。首次发布到那里的包可能是私有的，需要在 GitHub 的包设置中调整一次可见性。

发布可以安全地重复执行。如果某个版本已经存在且内容相同，脚本只设置它的标签；如果内容不同，脚本会停止。

`latest` 永远不会回退。比当前 `latest` 更旧的版本，例如旧版本线的修复，会改用
`backport` 标签发布。

## 发布版本

1. 确保 `main` 通过 CI。
2. 为提交打标签并推送：

   ```sh
   git tag v1.2.3
   git push origin v1.2.3
   ```

3. 如果 `npm` 环境配置了审批要求，`npm` 任务会等待批准，然后发布。

`npm` 任务需要一个能向 `@graftland` scope 发布包的 npm 访问令牌。在仓库设置的
**Environments** 中，将其保存为 `npm` 环境的 `NPM_TOKEN` 密钥。

## 文档站

工作流 `.github/workflows/docs.yml` 在每次推送到 `main` 时，从 `packages/docs`
构建本站，并部署到 GitHub
Pages：[graftland.github.io/graft](https://graftland.github.io/graft/)。也可以从 Actions 页面手动触发。同一时间只会进行一次部署。

仓库的 Pages 发布源必须设为 **GitHub Actions**。本地开发文档站时，运行：

```sh
devenv shell -- pnpm --filter @graftland/docs dev
```

英文页面位于 `packages/docs/content/docs`，中文页面位于其中的 `zh-cn`
目录，文件名与英文一致。页面之间使用 `../plugins/`
这样的相对链接，以确保站点设置基础路径后链接仍然有效。
