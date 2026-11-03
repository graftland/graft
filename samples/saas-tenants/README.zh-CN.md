# SaaS 租户

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

一个笔记服务在同一个进程中托管免费套餐的 Acorn 和专业套餐的 Northstar。每个工作区运行相同的
`storage` 和 `notes`
插件，它们的写法就好像只有一个租户。工作区加入和离开时，其他工作区继续提供服务。

## 问题

多租户通常会渗透到每一层。要么每个租户一个进程，要么在每次调用中传递
`tenantId`，让存储、配额检查和日志选中正确的租户。要在运行时接入租户，必须手工构建它的服务。要让租户退出，必须按正确的顺序找到并停止属于它的一切，同时不打扰其他任何人。

## Graft 的做法

`src/hosting.ts` 为每个工作区加载一次相同的 `tenant` 插件：

```ts
Graft.plugin(
	tenant,
	{ file: config.file },
	{
		isolate: [NoteStore],
		intercept: [
			Graft.intercept(Tenant, () => config.id),
			Graft.intercept(Plan, () => config.plan),
			Graft.intercept(References.CurrentLogAnnotations, (outer) => ({
				...outer,
				tenant: config.id,
			})),
		],
	},
)
```

- **隔离沿着树进行。** 每个租户的 `storage` 把 `NoteStore`
  发布到一个私有的 realm 中，所以它的 `notes`
  插件只能看到那个存储。两个租户都可以保存 ID 为 `launch`
  的笔记，各自读回的都是自己的那一条。`storage` 和 `notes`
  中没有任何地方接收租户 ID。
- **消费者等待它们的提供者。** `notes` 先加载，在其租户的存储发布之前一直处于
  `Pending`。然后它自动启动。
- **一个共享服务，按租户设置。** `Quota` 只在根部发布一次。它在被调用时读取
  `Plan`
  引用。事件处理器在注册它的插件的上下文中运行。因此同一个服务允许 Acorn 保存一条笔记，允许 Northstar 保存三条。租户的插件输出的每一行日志都带有
  `tenant: <id>`。
- **让租户退出只需一次调用。** 对租户调用 `fork.dispose`
  会移除它的请求处理器，停止
  `notes`，然后才刷新并关闭它的存储。另一个租户保留它的 fork、处理器和数据。

请求边界仍然负责选择租户。`request(id, command)` 用 `Event.filtered`
分发，与处理器的 `Tenant`
引用相匹配。它代表一个经过认证的 API 适配器。租户 ID 只存在于那里和预配过程中。Realm 隔离的是已发布的服务，不隔离文件系统访问，也不隔离根环境中的服务。

## 运行

在仓库根目录执行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-saas-tenants start
```

运行从本包中一个空的 `data/`
目录开始，并在其中为每个租户留下一个 JSON 文件。输出中值得关注的内容：

- 第 1 步：`Notes Pending: waiting for this tenant's NoteStore`，然后是
  `Storage opened` 和 `Notes ready`，每条都带有 `tenant: acorn`。
- 第 2 步：Northstar 读取 `launch` 得到 `Missing`，尽管 Acorn 有一条。
- 第 3 步：第二条笔记对 Acorn 被拒绝（`limit: 1`），对 Northstar 则被保存（`limit: 3`），两者用的是同一个配额服务。
- 第 4 步：Acorn 的 `Notes stopped` 出现在它的 `Storage flushed and closed`
  之前。此后 Acorn 没有处理器了，而 Northstar 仍然返回它自己的笔记。

存储把笔记保存在内存中，并在关闭时写入。它只是一个替身，不是能抵御崩溃的数据库。

`devenv shell -- pnpm --filter @graftland/sample-saas-tenants test`
会检查上述每一项说法。它使用内存文件系统。

## 文件

| 文件                        | 说明                                                           |
| --------------------------- | -------------------------------------------------------------- |
| `src/services.ts`           | 笔记 schema、服务键、`Plan` 和 `Tenant` 引用、请求和响应类型。 |
| `src/storage.ts`            | 租户的笔记，从它的 JSON 文件加载，并刷新写回该文件。           |
| `src/notes.ts`              | 笔记操作和请求处理器。                                         |
| `src/quota.ts`              | 共享的配额服务，读取调用方的 `Plan`。                          |
| `src/tenant.ts`             | 每个租户运行的插件。                                           |
| `src/hosting.ts`            | 使用 `isolate` 和 `intercept` 接入租户，以及请求路由。         |
| `src/lifecycle.ts`          | 等待 fork 变为 `Active`。                                      |
| `src/main.ts`               | 脚本化的运行。                                                 |
| `test/saas-tenants.test.ts` | 上述行为的测试。                                               |
