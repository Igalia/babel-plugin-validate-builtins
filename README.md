# @igalia/babel-plugin-validate-builtins

A Babel plugin that throws an error when your code uses a built-in (such as `Object.hasOwn` or `Array.prototype.findLast`) that is not supported by your targets.

It uses the same detection logic and compatibility data as [`babel-plugin-polyfill-corejs3`](https://github.com/babel/babel-polyfills/tree/main/packages/babel-plugin-polyfill-corejs3), but rather than injecting polyfills it reports an error. It is meant for projects that don't load polyfills for all the built-ins they use.

This plugin supports Babel 7 (7.4 or later) and Babel 8.

## Install

Using npm:

```sh
npm install --save-dev @igalia/babel-plugin-validate-builtins
```

or using yarn:

```sh
yarn add @igalia/babel-plugin-validate-builtins --dev
```

## Usage

Add this plugin to your Babel configuration:

```json
{
  "targets": "chrome 90",
  "plugins": ["@igalia/validate-builtins"]
}
```

Compiling this code:

```js
const last = items.findLast(item => item.enabled);
```

throws:

```
/path/to/input.js: [es.array.find-last] .findLast is not supported by your targets (chrome 90, requires chrome 97).
> 1 | const last = items.findLast(item => item.enabled);
    |              ^^^^^^^^^^^^^^

If you are already polyfilling it, you can allow it by adding the name in brackets to the "perFileExcludes" option of @igalia/babel-plugin-validate-builtins (to allow it only in some files) or to its "exclude" option (to allow it everywhere).
```

## Options

### `targets`, `ignoreBrowserslistConfig` and `configPath`

These options work like in every polyfill provider: see [babel-polyfills' docs](https://github.com/babel/babel-polyfills/blob/main/docs/usage.md#options).

When none of them is specified, this plugin uses the top-level [`targets`](https://babeljs.io/docs/options#targets) of your Babel configuration, which by default are read from your browserslist configuration. When there is no browserslist configuration, Babel 8 uses browserslist's `defaults` query, while with Babel 7 you need to specify your targets. Note that setting `ignoreBrowserslistConfig` or `configPath` without `targets` makes this plugin ignore the top-level targets.

The plugin throws if it can't determine any target to validate against. Any other option throws an error.

### `perFileExcludes`

`{ [moduleName: string]: string[] }`, defaults to `{}`.

Maps [core-js](https://github.com/zloirock/core-js) module names to arrays of globs: each module is allowed only in the files that match at least one of its globs, even when your targets don't support it. Each error starts with the names of the modules to exclude, in brackets; you can also find them in [core-js-compat's data](https://github.com/zloirock/core-js/blob/master/packages/core-js-compat/src/data.mjs).

Prefer this option over `exclude` whenever possible. Usually only some of your code can safely use a built-in that your targets don't support, for example because that code loads a polyfill or only runs in newer environments. Limiting the exclusion to those files means the plugin still catches the built-in everywhere else.

```json
{
  "plugins": [
    [
      "@igalia/validate-builtins",
      {
        "perFileExcludes": {
          "es.object.has-own": ["src/legacy/**"],
          "es\\.array\\.find-last.*": ["src/utils/*.js", "test/**"]
        }
      }
    ]
  ]
}
```

Keys work like the strings in `exclude`: they are regular expressions that must match the whole module name. The plugin throws if a key doesn't match any core-js module, or if a value isn't an array of strings.

Globs are matched using Node.js's [`path.matchesGlob`](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern). Relative globs are resolved against the directory of the configuration file that contains this plugin (or against Babel's `cwd`, when passing options programmatically), so they don't match files outside of it. Code compiled without a `filename` is never matched.

As with `exclude`, the plugin logs a warning about keys that only match built-ins already supported by your targets, and when an error lists multiple modules, excluding any one of them allows that usage.

It also logs a warning when a module is excluded both by `perFileExcludes` and by `exclude`: since `exclude` already allows it in all files, its `perFileExcludes` entry has no effect.

### `exclude`

`Array<string | RegExp>`, defaults to `[]`.

A list of core-js module names that are allowed in all files, even when your targets don't support them. Use it for built-ins that you polyfill globally, before any of your code runs; otherwise, prefer `perFileExcludes`.

Strings are treated as regular expressions that must match the whole module name.

```json
{
  "plugins": [
    [
      "@igalia/validate-builtins",
      { "exclude": ["es.object.has-own", "es\\.array\\.find-last.*"] }
    ]
  ]
}
```

Babel throws if a pattern doesn't match any core-js module. Strings that are not valid regular expressions are ignored.

If a pattern only matches built-ins that are already supported by your targets, this plugin logs a warning: you can remove it from `exclude`, together with the polyfills you are loading for it.

When an error lists multiple modules (for example, `[es.array.includes, es.string.includes] .includes is not supported`), excluding any one of them allows that usage.

Importing polyfills (for example, `import "core-js/actual/array/find-last"`) doesn't count as loading them: you still need to exclude them.

### `proposals`

`boolean`, defaults to `true`.

By default, this plugin also throws when you use built-ins that are still proposals, since browsers don't support most of them yet. Set it to `false` to only validate stable built-ins.

Proposal method names can collide with methods of your own objects (for example, `.chunks()` or `.uniqueBy()`). Use the `perFileExcludes` option or set `proposals` to `false` if this causes false positives.

## What is validated

- Babel can't always tell what type a value has. When an instance method could belong to more than one built-in (for example, `x.includes()` could be either `Array.prototype.includes` or `String.prototype.includes`), the plugin only throws when _none_ of them is supported by your targets. When it can infer the receiver (for example `[].includes()` or `"abc".at()`), it only checks that one.
- Any property access with the name of a built-in instance method is treated as that method. For example, `myObject.findLast()` is validated as `Array.prototype.findLast` even if `myObject` is not an array. Use the `perFileExcludes` option when this causes false positives.
- Using a global such as `Map` only checks the `Map` constructor itself, not all its methods. Methods are checked when you use them (for example, `map.getOrInsert()` or `set.union()`).
- Feature detection is not reported: `typeof structuredClone`, `"hasOwn" in Object`, `if (Object.hasOwn)`, `Object.hasOwn?.(a, b)`, and assigning or deleting a built-in. Code that only runs after checking that a built-in exists is not reported either, such as `Object.hasOwn && Object.hasOwn(a, b)` or `if (typeof structuredClone === "function") structuredClone(x)`. Checks that exit early (`if (!Object.hasOwn) return;`) are not recognized.
- The plugin only checks built-ins that appear explicitly in your code. It doesn't check built-ins that syntax needs implicitly, such as `Promise` for `async` functions or `Symbol.iterator` for `for...of` loops, nor code injected by other Babel plugins (such as the helpers injected by `@babel/preset-env`).
- The compatibility data comes from the installed version of `core-js-compat`, which considers a built-in unsupported until engines implement it without bugs. This plugin ignores fixes to built-ins that have been available since ES5 (for example `Array.prototype.push` or `JSON.stringify`), but reports newer built-ins with known bugs: for example, core-js considers `Array.prototype.includes` not fully supported by Safari yet.
