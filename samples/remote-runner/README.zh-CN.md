# 远程 runner

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

发票导出器要往账本里写数据，而你想把导出器放到另一台机器上。宿主重启后，重启前的导出器不能还在和新的导出器一起写。网络延迟又是另一个问题：旧导出器发出的写入，可能在新导出器启动后才到达。

本示例把导出器放在 runner 上运行，宿主通过双向 TLS 连接 runner。runner 确认旧导出器已经退出，才会启动新的；每次启动都会得到更大的
_generation_。账本记录见过的最新 generation，拒绝来自更旧 generation 的写入。

## 运行

使用 Linux 或 macOS、Node.js 22.22 或更高版本，并安装
`openssl`。在仓库根目录执行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-runner start
devenv shell -- pnpm --filter @graftland/sample-remote-runner test
```

所有东西都在本机运行，由 `src/lab.ts`
扮演 runner 机器：它生成证书，把构建好的包安装到
`.cache/lab/install`，并在 127.0.0.1 上启动 `graft-remote serve`。程序输出：

```text
Runner listening on port 52341
INV-1 exported by generation 1 (runner child 68017)
… Remote execution terminated … remote.generation: 1, remote.termination: Exited
INV-2 exported by generation 2 (runner child 68072)
A late write from generation 1 was rejected: the ledger has seen 2
… Remote execution terminated … remote.generation: 2, remote.termination: Exited
```

过程如下：

1. 宿主加载 `graft.yml`。`ledger` 条目在宿主上运行；`exporter`
   条目在 runner 上启动 worker，以条目 id `exporter`
   作为实例名。宿主上的一个插件调用
   `Exporter.export("INV-1")`，worker 再通过同一条连接调用宿主的
   `Ledger`，带上自己的 generation。
2. 宿主停止，并一直等到 runner 确认 worker 进程已经退出（`remote.termination: Exited`）。
3. 第二个全新的宿主加载同一个文件。条目 id 相同，所以请求的是同一个实例。runner 在新进程里以 generation
   2 启动它。
4. 宿主接着发送一条标着 generation
   1 的写入，模拟在网络上被耽搁的请求。账本已经见过 generation 2，于是以
   `StaleGeneration` 拒绝。

账本把写入保存在 `.cache/lab/ledger.json`。runner 把 generation 保存在
`.cache/lab/state`，只要这个目录还在，generation 就会一直递增。每次 `start`
都会重建
`.cache/lab`，所以每次输出的 generation 相同。测试用真实 runner 跑同样的流程，检查 generation、进程退出和拒绝结果。

## 文件

| 文件                         | 作用                                                     |
| ---------------------------- | -------------------------------------------------------- |
| `graft.yml`                  | 两个条目。导出器的条目 id 就是它的实例名。               |
| `src/contract.ts`            | 两边共用：配置、`Ledger` 和 `Exporter`、RPC、错误。      |
| `src/worker.ts`              | 在 runner 上运行，注入 `Ledger`，提供 `Exporter`。       |
| `src/exporter.ts`            | 条目入口，从环境变量读取 runner 地址和证书路径。         |
| `src/ledger.ts`              | 宿主插件，代表一个外部系统，负责检查 generation。        |
| `src/host.ts`                | 两次在全新的宿主运行时里加载 `graft.yml`，讲完整个流程。 |
| `src/lab.ts`                 | 扮演 runner 机器：证书、安装、`graft-remote serve`。     |
| `scripts/certificates.sh`    | 用 `openssl` 生成专用 CA，以及 runner 和宿主的证书。     |
| `test/remote-runner.test.ts` | 用真实 runner 跑一遍流程。                               |

runner 保证新进程启动前旧进程已经退出。generation 用来处理这个保证覆盖不到的情况：已经在路上的写入，以及 Graft 之外的系统。这些系统必须自己检查 generation，就像
`src/ledger.ts`
那样。generation 不能撤销已经接受的写入，也不能让调用恰好执行一次。

## 使用真正的 runner 机器

为 runner 的主机名生成证书，宿主身份为 `graft://billing`：

```sh
sh scripts/certificates.sh certs runner.example billing
```

把 `ca.crt`、`server.crt` 和 `server.key` 复制到 runner；`ca.crt`、`client.crt`
和 `client.key` 留在宿主上。`ca.key` 两边都不要放，它能签发新证书。

在 runner 上建立一个带有自己 `package.json` 的安装目录，把 `@graftland/remote`
和构建好的本示例包连同依赖安装进去，确保存在
`node_modules/@graftland/sample-remote-runner/package.json`。这些都是工作区包，不以已发布到 registry 为前提。然后交给进程管理器启动 runner，停止时覆盖整个进程组，重启时保留状态目录：

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert server.crt --key server.key --ca ca.crt
```

在宿主上，进入本目录，设置 `src/exporter.ts` 和 `src/ledger.ts`
读取的变量，然后启动 `graft.yml`：

```sh
RUNNER_HOST=runner.example RUNNER_PORT=7443 RUNNER_SERVERNAME=runner.example \
RUNNER_CA=certs/ca.crt RUNNER_CERT=certs/client.crt RUNNER_KEY=certs/client.key \
LEDGER_FILE=ledger.json pnpm exec graft start
```

导出器会在 runner 上启动。按 <kbd>Ctrl</kbd>+<kbd>C</kbd>，宿主会记录
`remote.termination: Exited`。再次启动，日志里的 generation 会加一。这种方式下没有插件调用导出器；要使用它，添加一个注入
`Exporter`
的宿主插件。租约、停止结果以及 runner 信任哪些东西，见[远程插件指南](https://graftland.github.io/graft/zh-cn/remote/)。
