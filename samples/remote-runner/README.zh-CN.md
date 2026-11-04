# Remote runner

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

发票导出插件通过 **wss + JWT**
在 runner 上运行，调用宿主的账本服务。宿主重启后，runner 先确认旧导出进程退出，再启动新进程。新实例的 generation 更大，账本据此拒绝旧实例延迟到达的写入。

## 运行

使用 Linux 或 macOS、Node.js 22.22 或更高版本。在仓库根目录运行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-runner start
devenv shell -- pnpm --filter @graftland/sample-remote-runner test
```

所有部分都在本机运行。`src/lab.ts` 用 `graft-remote certificates`
生成服务端证书，生成 ES256 密钥和
`sub: billing`、有效期十分钟的 JWT，将编译后的包安装到
`.cache/lab/install`，然后在 127.0.0.1 启动 runner。

宿主两次加载 `graft.yml`，显式加载 `host/websocket` 和 `host/auth/jwt`。
`ledger` 在宿主运行，`exporter` 在 runner 运行；保存的条目 id `exporter`
就是实例名。预期输出：

```text
Runner listening on port 52341
INV-1 exported by generation 1 (runner child 68017)
… remote.generation: 1, remote.termination: Exited
INV-2 exported by generation 2 (runner child 68072)
A late write from generation 1 was rejected: the ledger has seen 2
… remote.generation: 2, remote.termination: Exited
```

每次停止都会等待进程退出确认。第二个宿主使用同一实例名，因此 generation 递增。账本以
`StaleGeneration` 拒绝故意延迟的 generation
1 写入。测试验证两次调用、退出和 fencing。每次演示会重建
`.cache/lab`；实际部署须保留状态目录，让 generation 持续递增。

`src/contract.ts` 定义 `Ledger` 和 `Exporter`。`src/worker.ts`
是 runner 上的实现， `src/exporter.ts` 在激活时读取宿主设置，`src/host.ts`
演示重启过程。 `src/credentials.ts` 签发演示 token，`src/issue-token.ts`
提供可单独运行的脚本。

generation 检查由外部系统负责，能拒绝过期写入，不能撤销已接受的写入，也不保证调用恰好执行一次。

## 使用真实 runner 机器

构建完成后，在本示例目录生成演示 token 和服务端证书：

```sh
CREDENTIALS_DIR=.cache/credentials node dist/issue-token.js
pnpm exec graft-remote certificates --out certs --server runner.example
```

脚本写出 `jwt-public.pem` 和
`token`，不保存签名私钥。token 十分钟后过期。重新运行会生成新密钥，因此也须替换 runner 的公钥并重启它。这只是演示脚本，不是签发服务；实际部署使用自己的签发者及其公钥或 JWKS
URL。JWT 过期不会关闭已经认证的会话。被盗 token 在有效期内可被重放，应使用 wss 和短有效期。

把 `server.crt`/`server.key` 和 `jwt-public.pem` 复制到 runner，宿主保留
`ca.crt` 和 `token`，`ca.key` 由运维保管。不使用客户端 TLS 证书。 `certificates`
会复用已有 CA，`--force` 替换所请求的叶证书。

在拥有独立 `package.json` 的 `/srv/graft/install` 下安装
`@graftland/plugin-remote`、本示例编译后的包及依赖。这些是工作区包，不假定已发布到 registry。用外部进程管理器覆盖整个进程组，保留
`/var/lib/graft`：

```sh
graft-remote serve --listen wss://0.0.0.0:7443 --auth jwt \
  --cert server.crt --key server.key \
  --jwt-issuer https://issuer.example --jwt-audience graft \
  --jwt-algorithm ES256 --jwt-public-key jwt-public.pem \
  --root /srv/graft/install --state /var/lib/graft
```

在宿主的本示例目录：

```sh
RUNNER_HOST=runner.example RUNNER_PORT=7443 RUNNER_SERVERNAME=runner.example \
RUNNER_CA=certs/ca.crt RUNNER_TOKEN="$(cat .cache/credentials/token)" \
LEDGER_FILE=ledger.json pnpm exec graft start
```

按 Ctrl+C，等待
`remote.termination: Exited`；再用同一 YAML 启动，generation 会递增。这个手动模式只加载导出服务；需要调用时，添加一个注入
`Exporter` 的宿主插件。

## 通过 SSH 连接

将宿主 YAML 中的 `host/websocket`、`host/auth/jwt` 替换为
`@graftland/plugin-remote/host/command`，target 改为：

```ts
Remote.runner({
	transport: Remote.command([
		"ssh",
		"-T",
		"graft@runner.example",
		"graft-remote",
		"serve",
		"--stdio",
		"--identity",
		"billing",
		"--root",
		"/srv/graft/install",
		"--state",
		"/var/lib/graft-ssh",
	]),
	// The loader entry id supplies instance; do not add auth.
})
```

若要把一把 SSH 密钥限制为只运行这个命令，在远端账号的 `~/.ssh/authorized_keys`
中写入下面这一行，替换公钥占位符和可执行文件路径：

```text
restrict,command="/srv/graft/install/node_modules/.bin/graft-remote serve --stdio --identity billing --root /srv/graft/install --state /var/lib/graft-ssh" ssh-ed25519 AAAA... billing-host
```

SSH 验证调用者，强制命令固定 runner 身份。不要分配 TTY，也不要在 stdout 输出提示文字：stdout 承载协议，日志走 stderr。stdio 每个进程只服务一个会话，直到执行单元退出才释放状态锁。并发调用不能共用该目录；顺序调用保留递增的 generation。SSH 退出本身不代表远端已终止。这段 SSH 用法只作为说明，自动化示例测试覆盖的是 wss/JWT。

租约、三种停止结果、配置文件和信任边界见
[远程插件指南](https://graftland.github.io/graft/zh-cn/remote/)。
