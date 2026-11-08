# Chat bot

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

A chat bot whose commands, filters, and integrations are plugins. An operator
can load, reconfigure, and unload them while the bot keeps answering.

## The problem

A bot grows a long tail of features: `/roll`, `/weather`, a moderation filter,
and another integration next month. Each feature registers handlers, holds
connections, and depends on other parts. If you build this by hand, you usually
need:

- a central command registry, and code to remove a feature's handlers when it is
  turned off (or a restart to turn it off);
- a `/help` text that you must keep in sync with whatever is enabled;
- `if (weatherClient)` checks, or startup ordering rules, so that a command
  never runs before the client it needs and never outlives it;
- a plan for config errors, because an error in one feature can stop the whole
  bot from starting.

## What Graft does instead

- **Handlers belong to the plugin that registered them.** A command is
  `Event.on(Command, ...)` inside `apply`. When you unload the plugin, its
  handlers are removed. There is no registry to clean up. `/help` collects its
  lines with `Event.parallel(Describe)`, so it lists exactly what is loaded.
- **Dependencies control startup and shutdown.** `weather` declares
  `inject: [Forecasts]`. Without a provider, it stays `Pending` and its command
  does not exist. When `forecasts` loads, `weather` starts on its own. When
  `forecasts` unloads, `weather` stops _before_ the weather client disconnects.
- **Config changes can apply in place.** `moderation` returns an update
  function, so a new word list takes effect without restarting the filter.
- **Failures stay local.** An invalid config fails only that plugin, with the
  full `SchemaError`. The other commands keep answering.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-chat-bot start
```

What to look for in the output:

- Step 2: `weather is Pending, waiting for .../Forecasts`, and `/weather` is an
  unknown command.
- Step 3: `/weather` appears in `/help` as soon as `forecasts` loads. `weather`
  is not touched.
- Step 5: `Moderation now blocks 2 words`, with no `Moderation stopped` before
  it.
- Step 7: `/weather is gone` is logged before
  `Disconnected from the weather service`.

`devenv shell -- pnpm --filter @graftland/sample-chat-bot test` checks each of
these claims.

## Files

| File                        | What it is                                                     |
| --------------------------- | -------------------------------------------------------------- |
| `src/Chat.ts`               | The events plugins share, `command()`, and `receive(message)`. |
| `src/Forecasts.ts`          | The `Forecasts` service key.                                   |
| `src/plugins/help.ts`       | `/help`, built from whatever commands are loaded.              |
| `src/plugins/dice.ts`       | `/roll 2d6`.                                                   |
| `src/plugins/forecasts.ts`  | Publishes `Forecasts`. Stands in for a weather API client.     |
| `src/plugins/weather.ts`    | `/weather <city>`, which needs `Forecasts`.                    |
| `src/plugins/moderation.ts` | Middleware that removes messages with banned words.            |
| `src/main.ts`               | The scripted session.                                          |
| `test/chat-bot.test.ts`     | Tests for the behavior above.                                  |
