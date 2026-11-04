---
title: Overview
description:
  What Remote does, when to use it, and how a host, a runner and a plugin
  process fit together.
---

Remote runs a plugin's code somewhere other than your application's process,
while the rest of the application keeps using it as an ordinary service. This
page explains when that is useful, when it is not, and how the pieces fit
together. Read it before the other Remote pages.

## What problem it solves

Every Graft [plugin](../../plugins/) normally runs inside the application's
process. Sometimes you want one plugin to run elsewhere:

- **In its own process**, so that a crash, a memory leak or a blocked event loop
  in that plugin does not take the application down with it.
- **In a Node worker**, so that its work runs on a separate thread.
- **On another machine**, close to the data, hardware or network it needs.

With Remote, you move the plugin by changing one
[config entry](../../config-file/). The plugin still publishes its
[services](../../services/), and the plugins that use them still inject them as
usual. Their calls now travel over a connection to wherever the plugin runs.

## When not to use it

Remote isolates **execution**, not **permissions**.

- A plugin in a child process runs as your operating system user, with the same
  permissions as the application.
- A Node worker shares the application's process.
- A runner starts plugins with the permissions of the account it runs as.

If the plugin must not reach files, networks or secrets that the application
can, run the runner in a container or a VM and draw the boundary there. To
control which services plugins can see inside one process, use
[realms](../../isolation/) instead.

Moving a plugin also has a cost. Its configuration must encode as JSON, every
call becomes a message over a connection, and a call that fails because the
connection broke is not retried for you.

## How to picture it

These terms are used throughout the Remote pages:

| Term               | Meaning                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Host**           | Your Graft application. It loads the plugin through an entry named `remote`.                                                  |
| **Contract**       | A small module that both sides import. It names the plugin, describes its config and shared services, and points to its code. |
| **Implementation** | The plugin itself: an ordinary Graft plugin, built to JavaScript.                                                             |
| **Plugin process** | Where the implementation runs: a child process, a Node worker, or a process that a runner starts.                             |
| **Runner**         | A long-running service, usually on another machine, that accepts connections from hosts and starts plugin processes for them. |

There are two ways to run a plugin elsewhere:

```text
Direct:          host ─────────────────────── child process or worker
                                               (implementation)

Through runner:  host ──────── runner ──────── plugin process
                      wss, unix                (implementation)
                      or ssh
```

**Direct** is the simple case. The host starts a child process (`local`) or a
Node worker (`worker`) on its own machine. Nothing else needs to be installed or
running.

**Through a runner** is for other machines. You install the plugin package on
the runner's machine and start the runner there. The host connects to it, proves
who it is, and asks it to start the plugin. The host never uploads code.

|                       | Direct                                  | Through a runner                                                |
| --------------------- | --------------------------------------- | --------------------------------------------------------------- |
| Where the plugin runs | A child process or a worker on the host | A process the runner starts, usually on another machine         |
| What you set up       | Nothing beyond building the plugin      | Install the package on the runner and run `graft-remote serve`  |
| Connection            | Private to the host                     | WebSocket (`ws`/`wss`), a Unix socket, or a command such as SSH |
| Authentication        | Not needed                              | mTLS, a bearer token, a JWT, or the command's own (such as SSH) |
| Replacing a plugin    | Each start is a fresh process           | The old process must exit first; each replacement is numbered   |

Either way, each loaded `remote` entry gets its own plugin process, and that
process follows the entry's lifecycle. Stopping the entry stops the process.
Restarting the entry replaces it.

## A small example

Say `greeter` is a plugin that provides a `Greeter` service, and another plugin
injects `Greeter` to greet people. To run `greeter` in a child process, replace
its entry with a `remote` entry:

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello
```

- `contract` is the built contract module.
- `connect` says where the plugin runs. `local: {}` is a child process and
  `worker: {}` is a Node worker. A runner's address goes here too.
- The inner `config` is the plugin's own configuration.

The plugin that injects `Greeter` does not change.
[Getting started](../getting-started/) builds this example step by step.

## Samples

- [06 · Remote](https://github.com/graftland/graft/tree/main/samples/06-remote)
  moves one plugin between a child process, a worker and a runner without
  changing its caller.
- [Chat bot](https://github.com/graftland/graft/tree/main/samples/chat-bot) runs
  its weather integration in a child process.

## Where to go next

| Page                                                           | Read it when you want to…                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Getting started](../getting-started/)                         | Move your first plugin into a child process or a worker.            |
| [Run plugins on another machine](../runners/)                  | Deploy a runner and connect a host to it.                           |
| [Choose transport and authentication](../transport-auth/)      | Decide how hosts and runners connect, and what that protects.       |
| [Restarts, replacements and stopping](../restarts/)            | Know what happens on redeploys, network loss and slow shutdowns.    |
| [Write your own transport or authentication](../capabilities/) | Connect or authenticate in a way the built-in options do not cover. |
| [Reference](../reference/)                                     | Look up config fields, defaults, commands and errors.               |
