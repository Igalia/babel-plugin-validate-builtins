// Web APIs (such as `ResizeObserver` or `navigator.share`) are validated using
// MDN's browser-compat-data (BCD). This file converts BCD's `api.*` features
// to the same format as core-js-compat's data, and to definitions with the
// same shape as the ones in ./vendor/built-in-definitions.ts, so that the
// rest of the plugin can handle them like core-js modules.
//
// Each BCD feature `api.X.y` is called `web.X.y` by this plugin.

import bcd from "@mdn/browser-compat-data" with { type: "json" };
import electronToChromium from "electron-to-chromium/versions.json" with { type: "json" };
import type {
  Identifier,
  SupportBlock,
  SupportStatement,
} from "@mdn/browser-compat-data";
import type { CoreJSPolyfillDescriptor } from "./vendor/built-in-definitions.ts";
import { compareVersions } from "./versions.ts";

export type CompatData = Record<string, Record<string, string>>;

export type WebApis = {
  // Compat data of the features reported when using globals, static
  // properties and properties of singletons (such as `navigator.share`).
  compatData: CompatData;
  // Compat data of all the instance properties, only reported with the
  // "webInstanceMembers" option.
  instanceCompatData: CompatData;
  global: Record<string, CoreJSPolyfillDescriptor>;
  static: Record<string, Record<string, CoreJSPolyfillDescriptor>>;
  instance: Record<string, CoreJSPolyfillDescriptor>;
};

export const PREFIX = "web.";

// BCD browser name -> Babel target name
const BROWSERS = {
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  ie: "ie",
  opera: "opera",
  safari: "safari",
  safari_ios: "ios",
  webview_android: "android",
  samsunginternet_android: "samsung",
  opera_android: "opera_mobile",
  nodejs: "node",
  deno: "deno",
} as const;

// All the targets supported by @babel/helper-compilation-targets
const BABEL_TARGETS = [
  "android",
  "chrome",
  "deno",
  "edge",
  "electron",
  "firefox",
  "ie",
  "ios",
  "node",
  "opera",
  "opera_mobile",
  "rhino",
  "safari",
  "samsung",
];

// BCD's data about `Window` members in server runtimes describes the `Window`
// object, which they don't have, rather than their globals: for example, it
// says that Node.js doesn't support `Window.setImmediate`.
const SERVER_BROWSERS = new Set(["nodejs", "deno"]);

// Global objects whose properties are validated as members of the given
// interface (for example `navigator.share` as `Navigator.share`).
export const SINGLETONS: Record<string, string> = {
  caches: "CacheStorage",
  crypto: "Crypto",
  customElements: "CustomElementRegistry",
  document: "Document",
  history: "History",
  indexedDB: "IDBFactory",
  localStorage: "Storage",
  location: "Location",
  navigator: "Navigator",
  performance: "Performance",
  screen: "Screen",
  sessionStorage: "Storage",
  speechSynthesis: "SpeechSynthesis",
  visualViewport: "VisualViewport",
};

// core-js's `web.*` modules are not used, since BCD covers those web APIs.
// When users try to exclude them, we tell them which name to use instead
// (or null when that built-in is not reported anymore).
export const coreJSWebModuleReplacements: Record<string, string[] | null> = {
  "web.atob": ["web.atob"],
  "web.btoa": ["web.btoa"],
  "web.dom-collections.for-each": null,
  "web.dom-collections.iterator": null,
  "web.dom-exception.constructor": ["web.DOMException"],
  "web.dom-exception.stack": null,
  "web.dom-exception.to-string-tag": null,
  "web.immediate": ["web.Window.setImmediate", "web.Window.clearImmediate"],
  "web.queue-microtask": ["web.queueMicrotask"],
  "web.self": ["web.Window.self"],
  "web.structured-clone": ["web.structuredClone"],
  "web.timers": ["web.setTimeout", "web.setInterval"],
  "web.url": ["web.URL"],
  "web.url.can-parse": ["web.URL.canParse_static"],
  "web.url.parse": ["web.URL.parse_static"],
  "web.url.to-json": null,
  "web.url-search-params": ["web.URLSearchParams"],
  "web.url-search-params.delete": null,
  "web.url-search-params.has": null,
  "web.url-search-params.size": null,
};

// @babel/helper-compilation-targets uses the Chrome version for Android when
// the compat data doesn't contain one, so omitting Android doesn't mean that
// a feature is unsupported. We use a version that will never exist instead.
export const NEVER_SUPPORTED = "999999";

export const isCoreJSWebModule = (name: string) => name.startsWith("web.");

// The lowest version in which the feature is supported without flags,
// prefixes, alternative names or partial implementations.
function lowestSupportedVersion(statement: SupportStatement): string | null {
  let result: string | null = null;
  for (const s of [statement].flat()) {
    if (s.flags || s.prefix || s.alternative_name) continue;
    if (s.partial_implementation || s.version_removed) continue;
    if (typeof s.version_added !== "string") continue;
    if (s.version_added === "preview") continue;
    // "≤N" means that it's supported at least since version N.
    const version = s.version_added.replace(/^≤/, "");
    if (result == null || compareVersions(version, result) < 0) {
      result = version;
    }
  }
  return result;
}

const electronVersions = Object.keys(electronToChromium).sort(compareVersions);

function chromeToElectron(chromeVersion: string): string | null {
  const major = Number(chromeVersion.split(".")[0]);
  const electron = electronVersions.find(
    version => Number(electronToChromium[version]) >= major,
  );
  return electron ?? null;
}

// Converts BCD's support data to core-js-compat's format: an object mapping
// each Babel target to the lowest version that supports the feature. When BCD
// has no data for a target, we consider the feature supported.
export function bcdSupportToCompat(
  support: SupportBlock,
  { ignoreServerData = false } = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const target of BABEL_TARGETS) result[target] = "0";

  for (const [browser, target] of Object.entries(BROWSERS)) {
    if (ignoreServerData && SERVER_BROWSERS.has(browser)) continue;
    const statement = support[browser];
    if (statement == null) continue;
    const version = lowestSupportedVersion(statement);
    if (version == null) delete result[target];
    else result[target] = version;
  }

  result.android ??= NEVER_SUPPORTED;

  if (result.chrome == null) {
    delete result.electron;
  } else if (result.chrome !== "0") {
    const electron = chromeToElectron(result.chrome);
    if (electron == null) delete result.electron;
    else result.electron = electron;
  }

  return result;
}

// BCD also contains sub-features that are not properties, such as events
// (`X_event`) or behaviors (`worker_support`, `secure_context_required`).
const isProperty = (key: string) =>
  /^[A-Za-z$][\w$]*$/.test(key) && !key.includes("_");

const subFeatures = (feature: Identifier) =>
  Object.entries(feature).filter(([key]) => key !== "__compat") as Array<
    [string, Identifier]
  >;

const define = (ids: string[]): CoreJSPolyfillDescriptor => ({
  name: ids[0],
  pure: null,
  global: ids,
  exclude: null,
});

let webApis: WebApis | null = null;

export function getWebApis(): WebApis {
  if (webApis) return webApis;

  const api: Record<string, Identifier> = bcd.api;
  const compatData: CompatData = {};
  const instanceCompatData: CompatData = {};
  const global: WebApis["global"] = {};
  const statics: WebApis["static"] = {};
  const instanceIds = new Map<string, string[]>();

  const addCompat = (
    data: CompatData,
    id: string,
    node: Identifier,
    options?: { ignoreServerData?: boolean },
  ) => {
    data[id] ??= bcdSupportToCompat(node.__compat.support, options);
  };

  const addStatic = (object: string, key: string, id: string) => {
    statics[object] ??= {};
    statics[object][key] = define([id]);
  };

  for (const [name, iface] of Object.entries(api)) {
    // Interfaces with underscores in their name, such as
    // `ANGLE_instanced_arrays`, are WebGL extensions and not globals.
    if (!iface.__compat || !isProperty(name)) continue;

    const ifaceId = `${PREFIX}${name}`;
    // Overwrite `Window` members with the same name, if any.
    global[name] = define([ifaceId]);
    addCompat(compatData, ifaceId, iface);

    for (const [key, member] of subFeatures(iface)) {
      if (key === name || !member.__compat) continue;
      const id = `${ifaceId}.${key}`;

      if (key.endsWith("_static")) {
        const property = key.slice(0, -"_static".length);
        if (!isProperty(property)) continue;
        addStatic(name, property, id);
        addCompat(compatData, id, member);
        continue;
      }
      if (!isProperty(key)) continue;

      if (name === "Window") {
        // Prefer top-level features (such as `api.fetch`), if any.
        global[key] ??= define([id]);
        addCompat(compatData, id, member, { ignoreServerData: true });
        continue;
      }

      if (instanceIds.has(key)) instanceIds.get(key).push(id);
      else instanceIds.set(key, [id]);
      addCompat(instanceCompatData, id, member);
    }
  }

  for (const [object, ifaceName] of Object.entries(SINGLETONS)) {
    for (const [key, member] of subFeatures(api[ifaceName])) {
      if (key === ifaceName || !member.__compat) continue;
      if (!isProperty(key)) continue;
      const id = `${PREFIX}${ifaceName}.${key}`;
      addStatic(object, key, id);
      addCompat(compatData, id, member);
    }
  }

  const instance: WebApis["instance"] = {};
  for (const [key, ids] of instanceIds) {
    instance[key] = define(ids);
  }

  webApis = {
    compatData,
    instanceCompatData,
    global,
    static: statics,
    instance,
  };
  return webApis;
}
