# CLAUDE.md

Notes for working on `ioBroker.fritzbox`.

## What the adapter does

It connects to the **call monitor** of an AVM FRITZ!Box on **TCP port 1012** and turns the
messages of that port into ioBroker states: who is calling, who was missed, call lists as
txt/html/json and a realtime call monitor.

The call monitor has to be switched on once by dialing `#96*5*` on a phone of the box
(`#96*4*` switches it off). Without that, port 1012 stays closed and the adapter only logs
reconnect attempts.

Optionally, if a TR-064 user and password are configured, the adapter also reads the WLAN state
(and can switch it), the phone book and the answering machine over **TR-064 on port 49000**.

Newcomers are usually pointed at `ioBroker.tr-064`, which does much more. This adapter is kept
alive because many long-standing installations built their VIS views on its states.

## Commands

```bash
npm run build            # tsc -p tsconfig.build.json  ->  build/
npm run watch            # the same, watching
npm run check            # type check only, no emit
npm run lint             # eslint (use `npx eslint -c eslint.config.mjs --fix` to fix)
npm run test:package     # validates package.json / io-package.json / admin json
npm run test:integration # starts a js-controller, fails if one is already running
npm run translate        # translate-adapter -b admin/i18n/en.json
```

There is deliberately **no `prepare` script**. `build/` is gitignored and `common.nogit: true`
is set in `io-package.json`, so the adapter is installed from npm, not from GitHub. The build
runs in `npm run build` and in the CI (`build: true` in the workflow), nowhere else.

## Layout

```
src/main.ts             the adapter class `Fritzbox extends utils.Adapter`
src/lib/tr064.ts        `Tr064Client` - WLAN, answering machine and phone book over TR-064
src/lib/utils.ts        pure formatting helpers of the call lists
src/lib/types.ts        interfaces of the calls and of the XML the FRITZ!Box delivers
src/lib/adapter-config.d.ts   the type of `this.config`
src/types/tr-064.d.ts   hand written typings for the untyped `tr-064` package
admin/jsonConfig.json   the configuration dialog
admin/i18n/<lang>.json  flat translation files, keys are the English labels
test/                   @iobroker/testing v5
doc/, widgets/          screenshots and VIS example widgets of the README
```

Three key lists have to stay identical - if they drift apart, instances silently lose settings
when the config dialog is saved for the first time:

`native` in `io-package.json` == items of `admin/jsonConfig.json` == `ioBroker.AdapterConfig`
in `src/lib/adapter-config.d.ts`.

## Conventions

- **All padding is done with utf-8 non-breaking spaces**, written as `\u00A0` escapes in the source
  (`NBSP` in `src/lib/utils.ts`). The VIS widgets rely on it - a normal space breaks the column
  alignment. `numberFormat()` replaces every normal space it produces by `NBSP`.
- **The states are the public API.** Object ids, `cdr.json` property names and the `native`
  field names are used by user scripts and by the example widgets. Do not rename them.
- **Timers** always through `this.setTimeout` / `this.setInterval` of adapter-core, so they are
  cleaned up on unload.
- **The adapter runs in compact mode** (`common.compact`), so the process survives a stopped
  instance. Everything `onReady()` opened has to be closed in `onUnload()`, and every async
  continuation that starts a timer or writes a state has to check `this.unloaded` first - a
  TR-064 request that is still on its way would otherwise resurrect the WLAN poll timer.
- The states are created from `instanceObjects` in `io-package.json`, the adapter never creates
  objects itself. A new state has to be added there.
- `fritzboxPassword` is listed in `encryptedNative`, so js-controller encrypts it. The
  JsonConfig field is therefore a plain `password` field **without** `"encrypted": true` -
  adding that would encrypt the value twice and invalidate the stored credentials.

## Known quirks of the original code, kept on purpose

These look wrong but changing them changes the output of existing installations:

- `e164()` counts the leading zeros with `substring(i, 2 * i + 1)` (the original `substr(i, i + 1)`),
  which stops after the first zero for most numbers.
- `durationForm()` pads the seconds of durations over an hour with non-breaking spaces instead
  of `0`, because `fill(n, 0)` falls back to the default padding.
- `publishCallState()` reads `calls.missedCount` back asynchronously, so the value only arrives
  after the message has been processed.
- `ringActualNumbers` always pushes the number of the youngest ringing call, not of each one.
- `DELTA_TIME_OK_SEC`, `HISTORY_ALL_LINES` and `HISTORY_MISSED_LINES` are constants. There used
  to be `native` entries for them, but the code never read them, so they were removed.

## Release

`.releaseconfig.json` uses the iobroker, license and manual-review plugins.

```bash
npm run release-patch    # or -minor / -major
```

The changelog entry goes under the `### **WORK IN PROGRESS**` placeholder in `README.md`,
`common.news` in `io-package.json` is written by the release script - do not edit it by hand.
