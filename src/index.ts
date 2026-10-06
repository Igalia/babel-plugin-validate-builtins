import path from "node:path";
import corejs3Polyfills from "core-js-compat/data.json" with { type: "json" };
import {
  BuiltIns,
  StaticProperties,
  InstanceProperties,
  type CoreJSPolyfillDescriptor,
} from "./vendor/built-in-definitions.ts";
import canSkipPolyfill from "./vendor/usage-filters.ts";
import { complianceFixes, obsoleteProposals } from "./ignored-modules.ts";
import { isFeatureDetection, isGuarded } from "./feature-detection.ts";
import {
  PREFIX as WEB_API_PREFIX,
  coreJSWebModuleReplacements,
  getWebApis,
  isCoreJSWebModule,
  type CompatData,
} from "./web-apis.ts";
import { compareVersions } from "./versions.ts";

import type {
  File,
  NodePath,
  PluginAPI,
  PluginObject,
  types as t,
} from "@babel/core";
import {
  getInclusionReasons,
  isRequired,
} from "@babel/helper-compilation-targets";

import defineProvider from "@babel/helper-define-polyfill-provider";

const PACKAGE_NAME = "@igalia/babel-plugin-validate-builtins";

const SUPPORTED_OPTIONS = new Set([
  "targets",
  "ignoreBrowserslistConfig",
  "configPath",
  "exclude",
  "proposals",
  "perFileExcludes",
  "webApis",
  "webInstanceMembers",
]);

type Options = {
  proposals?: boolean;
  perFileExcludes?: Record<string, string[]>;
  webApis?: boolean;
  webInstanceMembers?: boolean;
};

type PerFileExclude = {
  pattern: string;
  regexp: RegExp;
  globs: string[];
};

type Meta =
  | { kind: "global"; name: string }
  | {
      kind: "property" | "in";
      placement: "static" | "prototype" | null;
      object: string | null;
      key: string;
    };

type Resolved = {
  kind: "global" | "static" | "instance";
  name: string;
  desc: CoreJSPolyfillDescriptor;
};

type Violation = {
  node: t.Node;
  message: string;
};

// Copied from babel-plugin-polyfill-corejs3
const uniqueObjects = [
  "array",
  "string",

  "iterator",
  "async-iterator",
  "dom-collections",
].map(v => new RegExp(`[a-z]*\\.${v}\\..*`));

const kebabCase = (key: string) =>
  key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

const camelCase = (name: string) =>
  name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

// babel-plugin-polyfill-corejs3 doesn't list the methods of collections (such
// as `Map.prototype.getOrInsert` or `Set.prototype.union`) as instance
// properties, because it loads them together with their constructor. Derive
// them from the dependencies of the global built-ins.
// Some of those dependencies are not prototype methods: `cause` is an own
// property of errors, and `toStringTag` is `Reflect[Symbol.toStringTag]`.
const notPrototypeMethods = new Set(["cause", "toStringTag"]);
const CollectionInstanceProperties: Record<string, CoreJSPolyfillDescriptor> =
  {};
for (const globalName of Object.keys(BuiltIns)) {
  const prefix = `es.${kebabCase(globalName[0].toLowerCase() + globalName.slice(1))}.`;
  for (const name of BuiltIns[globalName].global) {
    if (!name.startsWith(prefix)) continue;
    const method = camelCase(name.slice(prefix.length).replace(/\.v2$/, ""));
    if (method === "constructor" || method.includes(".")) continue;
    if (notPrototypeMethods.has(method)) continue;
    if (Object.hasOwn(InstanceProperties, method)) continue;

    CollectionInstanceProperties[method] ??= {
      name,
      pure: null,
      global: [],
      exclude: null,
    };
    CollectionInstanceProperties[method].global.push(name);
  }
}

// core-js also polyfills some web APIs, in its `web.*` modules. We validate
// all the web APIs using MDN's data instead (see ./web-apis.ts), so we remove
// them from core-js's data and definitions. MDN's data also takes precedence
// for globals that core-js handles without `web.*` modules (such as `fetch`).
const webApis = getWebApis();

const coreJSData = Object.fromEntries(
  Object.entries(corejs3Polyfills).filter(([name]) => !isCoreJSWebModule(name)),
) as CompatData;

function withoutWebApis(
  definitions: Record<string, CoreJSPolyfillDescriptor>,
  isWebApi: (key: string) => boolean = () => false,
) {
  const result: Record<string, CoreJSPolyfillDescriptor> = {};
  for (const [key, desc] of Object.entries(definitions)) {
    if (isWebApi(key) || isCoreJSWebModule(desc.name)) continue;
    const global = desc.global.filter(name => !isCoreJSWebModule(name));
    if (global.length === 0) continue;
    result[key] = { ...desc, global };
  }
  return result;
}

const coreJSGlobal = withoutWebApis(BuiltIns, key =>
  Object.hasOwn(webApis.global, key),
);
const coreJSStatic: Record<
  string,
  Record<string, CoreJSPolyfillDescriptor>
> = {};
for (const [object, properties] of Object.entries(StaticProperties)) {
  coreJSStatic[object] = withoutWebApis(properties, key =>
    Object.hasOwn(webApis.static[object] ?? {}, key),
  );
}
const coreJSInstance = withoutWebApis({
  ...CollectionInstanceProperties,
  ...InstanceProperties,
});

const mergedGlobal = { ...coreJSGlobal, ...webApis.global };
const mergedStatic = { ...webApis.static };
for (const [object, properties] of Object.entries(coreJSStatic)) {
  mergedStatic[object] = { ...webApis.static[object], ...properties };
}

// The compat data of all the built-ins that can be reported, with each
// combination of the "webApis" and "webInstanceMembers" options.
const compatDataCache = new Map<string, CompatData>();
function getCompatData(validateWebApis: boolean, webInstanceMembers: boolean) {
  if (!validateWebApis) return coreJSData;
  const key = String(webInstanceMembers);
  if (!compatDataCache.has(key)) {
    compatDataCache.set(key, {
      ...coreJSData,
      ...webApis.compatData,
      ...(webInstanceMembers && webApis.instanceCompatData),
    });
  }
  return compatDataCache.get(key);
}
const coreJSWebModules =
  Object.keys(corejs3Polyfills).filter(isCoreJSWebModule);

function describeUsage(meta: Meta, resolved: Resolved) {
  if (resolved.kind === "global" || meta.kind === "global") {
    return resolved.name;
  }
  if (resolved.kind === "static") return `${meta.object}.${meta.key}`;
  if (meta.object && meta.placement === "prototype") {
    return `${meta.object}.prototype.${meta.key}`;
  }
  return `.${meta.key}`;
}

// Babel might instantiate the plugin once per file: only log each warning once.
const loggedWarnings = new Set<string>();
function warnOnce(message: string) {
  if (loggedWarnings.has(message)) return;
  loggedWarnings.add(message);
  console.warn(message);
}

// Same as @babel/helper-define-polyfill-provider
function toRegExp(pattern: string | RegExp): RegExp | null {
  if (pattern instanceof RegExp) return pattern;
  try {
    return new RegExp(`^${pattern}$`);
  } catch {
    return null;
  }
}

const prettifyVersion = (version: string) => version.replace(/(\.0)+$/, "");

// When users try to exclude core-js's `web.*` modules, which we don't use
// anymore, tell them which names to use instead.
function checkCoreJSWebModules(
  description: string,
  patterns: Array<string | RegExp>,
  names: string[],
) {
  const errors: string[] = [];
  for (const pattern of patterns) {
    const regexp = toRegExp(pattern);
    if (!regexp || names.some(name => regexp.test(name))) continue;
    const modules = coreJSWebModules.filter(name => regexp.test(name));
    if (modules.length === 0) continue;
    const replacements = new Set(
      modules.flatMap(name => coreJSWebModuleReplacements[name] ?? []),
    );
    const fix =
      replacements.size === 0
        ? "it is not reported anymore, so you can remove it"
        : `use ${Array.from(replacements).join(", ")} instead`;
    errors.push(`  - ${String(pattern)}: ${fix}.\n`);
  }
  if (errors.length === 0) return;
  throw new Error(
    `${PACKAGE_NAME}: web APIs are now validated using MDN's ` +
      `browser-compat-data rather than core-js's \`web.*\` modules. The ` +
      `following ${description} only match core-js modules that are not used anymore:\n` +
      errors.join(""),
  );
}

function normalizePerFileExcludes(
  perFileExcludes: unknown,
  names: string[],
): PerFileExclude[] {
  if (perFileExcludes == null) return [];
  if (typeof perFileExcludes !== "object" || Array.isArray(perFileExcludes)) {
    throw new Error(
      `${PACKAGE_NAME}: the "perFileExcludes" option must be an object.`,
    );
  }

  const result: PerFileExclude[] = [];
  const unmatched: string[] = [];
  for (const [pattern, globs] of Object.entries(perFileExcludes)) {
    if (!Array.isArray(globs) || !globs.every(g => typeof g === "string")) {
      throw new Error(
        `${PACKAGE_NAME}: the "perFileExcludes" option must map each ` +
          `module name to an array of globs.`,
      );
    }

    const regexp = toRegExp(pattern);
    if (!regexp || !names.some(n => regexp.test(n))) {
      unmatched.push(pattern);
    } else {
      result.push({ pattern, regexp, globs });
    }
  }

  if (unmatched.length > 0) {
    throw new Error(
      `${PACKAGE_NAME}: the following "perFileExcludes" keys didn't match ` +
        `any core-js module or MDN feature:\n` +
        unmatched.map(p => `  - ${p}\n`).join(""),
    );
  }

  return result;
}

// Globs are relative to the directory of the configuration file that
// contains the plugin (or to the current working directory, when passing
// options programmatically), like Babel's "only" and "ignore" options.
function getFileExcludes(
  perFileExcludes: PerFileExclude[],
  dirname: string,
  filename: string | null | undefined,
): RegExp[] {
  if (perFileExcludes.length === 0 || filename == null) return [];
  const relative = path.relative(dirname, filename);
  return perFileExcludes
    .filter(({ globs }) =>
      globs.some(glob =>
        path.matchesGlob(path.isAbsolute(glob) ? filename : relative, glob),
      ),
    )
    .map(({ regexp }) => regexp);
}

const provider = defineProvider<Options>(function (
  { createMetaResolver, shouldInjectPolyfill, targets },
  {
    proposals = true,
    exclude = [],
    perFileExcludes: rawPerFileExcludes,
    webApis: validateWebApis = true,
    webInstanceMembers = false,
  },
  dirname: string,
) {
  if (Object.keys(targets).length === 0) {
    throw new Error(
      `${PACKAGE_NAME}: could not find any target to validate against. ` +
        `Please specify your targets using the "targets" option.`,
    );
  }

  if (webInstanceMembers && !validateWebApis) {
    throw new Error(
      `${PACKAGE_NAME}: the "webInstanceMembers" option requires the ` +
        `"webApis" option to be enabled.`,
    );
  }

  const compatData = getCompatData(validateWebApis, webInstanceMembers);
  const knownNames = Object.keys(compatData);

  checkCoreJSWebModules(`"exclude" patterns`, exclude, knownNames);
  if (rawPerFileExcludes != null && typeof rawPerFileExcludes === "object") {
    checkCoreJSWebModules(
      `"perFileExcludes" keys`,
      Object.keys(rawPerFileExcludes),
      knownNames,
    );
  }

  const perFileExcludes = normalizePerFileExcludes(
    rawPerFileExcludes,
    knownNames,
  );

  const resolve = createMetaResolver({
    global: validateWebApis ? mergedGlobal : coreJSGlobal,
    static: validateWebApis ? mergedStatic : coreJSStatic,
    instance: webInstanceMembers
      ? { ...webApis.instance, ...coreJSInstance }
      : coreJSInstance,
  });

  // Copied from babel-plugin-polyfill-corejs3
  function isFeatureStable(name: string) {
    if (name.startsWith("esnext.")) {
      const esName = `es.${name.slice(7)}`;
      // If its imaginative esName is not in latest compat data, it means
      // the proposal is not stage 4
      return esName in corejs3Polyfills;
    }
    return true;
  }

  function filterPolyfills(name: string) {
    return proposals || isFeatureStable(name);
  }

  function isSupported(name: string) {
    return complianceFixes.has(name) || !shouldInjectPolyfill(name);
  }

  // Whether this plugin would never report `name`, regardless of `exclude`.
  function isNeverReported(name: string) {
    return (
      !filterPolyfills(name) ||
      complianceFixes.has(name) ||
      obsoleteProposals.has(name) ||
      !isRequired(name, targets, { compatData })
    );
  }

  function warnUnnecessaryExclusions(
    description: string,
    patterns: Array<string | RegExp>,
  ) {
    const unnecessary = patterns.filter(pattern => {
      const regexp = toRegExp(pattern);
      if (!regexp) return false;
      const matches = knownNames.filter(name => regexp.test(name));
      // Patterns that don't match anything are reported elsewhere.
      return matches.length > 0 && matches.every(isNeverReported);
    });
    if (unnecessary.length === 0) return;
    warnOnce(
      `${PACKAGE_NAME}: the following ${description} only match ` +
        `built-ins that are supported by your targets:\n` +
        unnecessary.map(p => `  - ${String(p)}\n`).join("") +
        `You can remove them, together with any polyfill you are loading ` +
        `for them.`,
    );
  }
  warnUnnecessaryExclusions(`"exclude" patterns`, exclude);
  warnUnnecessaryExclusions(
    `"perFileExcludes" keys`,
    perFileExcludes.map(({ pattern }) => pattern),
  );

  const excludeRegExps = exclude.map(toRegExp).filter(r => r != null);
  const duplicateExclusions = knownNames.filter(
    name =>
      !isNeverReported(name) &&
      excludeRegExps.some(regexp => regexp.test(name)) &&
      perFileExcludes.some(({ regexp }) => regexp.test(name)),
  );
  if (duplicateExclusions.length > 0) {
    warnOnce(
      `${PACKAGE_NAME}: the following built-ins are excluded both by ` +
        `"exclude" and by "perFileExcludes":\n` +
        duplicateExclusions.map(name => `  - ${name}\n`).join("") +
        `"exclude" already allows them in all files, so their ` +
        `"perFileExcludes" entries have no effect. Remove them from one of ` +
        `the two options.`,
    );
  }

  // core-js-compat descriptors list every module that has to be loaded to
  // polyfill a built-in, including its dependencies: for example, `Map`
  // depends on all the `Map.prototype` methods, and `.map` depends both on
  // `Array.prototype.map` and on `Iterator.prototype.map`. That is what we
  // want when injecting polyfills, but when validating it would report
  // built-ins that are not being used.
  // We thus only validate the modules implementing the used built-in.
  function getCandidates(meta: Meta, resolved: Resolved, deps: string[]) {
    if (resolved.kind !== "instance" || meta.kind === "global") {
      return filterPolyfills(resolved.desc.name) ? [resolved.desc.name] : [];
    }

    // MDN's instance properties list one feature per interface that has a
    // property with that name.
    if (resolved.desc.name.startsWith(WEB_API_PREFIX)) {
      if (meta.placement === "prototype" && meta.object) {
        const own = deps.filter(name =>
          name.startsWith(`${WEB_API_PREFIX}${meta.object}.`),
        );
        if (own.length > 0) return own;
      }
      return deps;
    }

    const available = deps.filter(
      name => !obsoleteProposals.has(name) && filterPolyfills(name),
    );

    const key = kebabCase(meta.key);
    const own = available.filter(name => {
      const parts = name.split(".");
      return (
        parts.indexOf(key, 2) !== -1 ||
        parts.indexOf(`${key}-alternative`, 2) !== -1
      );
    });
    return own.length > 0 ? own : available;
  }

  function formatTargets(candidates: string[]) {
    // For each target, the lowest version that supports the built-in (if
    // there are multiple candidates, any of them).
    const required = new Map<string, string | null>();
    for (const name of candidates) {
      const unsupported = getInclusionReasons(name, targets, compatData);
      for (const env of Object.keys(unsupported)) {
        const version = compatData[name][env];
        const current = required.get(env);
        if (version == null) {
          if (!required.has(env)) required.set(env, null);
        } else if (current == null || compareVersions(version, current) < 0) {
          required.set(env, String(version));
        }
      }
    }

    return Array.from(required.keys())
      .sort()
      .map(env => {
        const target = `${env} ${prettifyVersion(targets[env])}`;
        const version = required.get(env);
        return version == null
          ? `${target}, not supported by any version`
          : `${target}, requires ${env} ${prettifyVersion(version)}`;
      })
      .join("; ");
  }

  // We collect all the unsupported built-ins used in the current file, so
  // that we can report all of them at once in post().
  let violations: Violation[] | null = null;
  let reportedNodes: WeakSet<t.Node> | null = null;
  let fileExcludes: RegExp[] | null = null;

  function isAllowed(name: string) {
    return isSupported(name) || fileExcludes.some(regexp => regexp.test(name));
  }

  function validate(
    meta: Meta,
    resolved: Resolved,
    deps: string[],
    path: NodePath,
  ) {
    const candidates = getCandidates(meta, resolved, deps);

    // When we cannot statically know the receiver of an instance method,
    // there might be multiple candidates (e.g. `.includes` could be either
    // `Array.prototype.includes` or `String.prototype.includes`): we only
    // report it if none of them is supported.
    if (candidates.length === 0 || candidates.some(isAllowed)) return;

    if (isFeatureDetection(path) || isGuarded(path)) return;

    // The same node can be visited multiple times, for example when other
    // plugins requeue it.
    if (reportedNodes.has(path.node)) return;
    reportedNodes.add(path.node);

    violations.push({
      node: path.node,
      message:
        `[${candidates.join(", ")}] ` +
        `${describeUsage(meta, resolved)} is not supported by your targets ` +
        `(${formatTargets(candidates)}).`,
    });
  }

  return {
    name: PACKAGE_NAME,

    polyfills: compatData,

    filterPolyfills,

    pre(file: File) {
      violations = [];
      reportedNodes = new WeakSet();
      fileExcludes = getFileExcludes(
        perFileExcludes,
        dirname,
        file.opts.filename,
      );
    },

    post(file: File) {
      const fileViolations = violations;
      violations = reportedNodes = fileExcludes = null;
      if (fileViolations.length === 0) return;

      fileViolations.sort(
        (a, b) =>
          a.node.loc.start.line - b.node.loc.start.line ||
          a.node.loc.start.column - b.node.loc.start.column,
      );

      const [pronoun, names] =
        fileViolations.length === 1
          ? ["it", "the name"]
          : ["them", "the names"];

      throw new SyntaxError(
        fileViolations
          .map(
            ({ node, message }) =>
              file.buildCodeFrameError(node, message).message,
          )
          .join("\n\n") +
          `\n\nIf you are already polyfilling ${pronoun}, you can allow ` +
          `${pronoun} by adding ${names} in brackets to the ` +
          `"perFileExcludes" option of ${PACKAGE_NAME} (to allow ${pronoun} ` +
          `only in some files) or to its "exclude" option (to allow ` +
          `${pronoun} everywhere).`,
      );
    },

    usageGlobal(meta: Meta, utils, path: NodePath) {
      // Only validate code written by the user, and not code injected by
      // other plugins (such as Babel helpers).
      if (!path.node.loc) return;

      // "key" in obj checks whether a built-in exists.
      if (meta.kind === "in") return;

      // Copied from babel-plugin-polyfill-corejs3
      const resolved: Resolved | undefined = resolve(meta);
      if (!resolved) return;

      if (canSkipPolyfill(resolved.desc, path)) return;

      let deps = resolved.desc.global;

      if (
        resolved.kind !== "global" &&
        "object" in meta &&
        meta.object &&
        meta.placement === "prototype"
      ) {
        const low = meta.object.toLowerCase();
        deps = deps.filter(m =>
          uniqueObjects.some(v => v.test(m)) ? m.includes(low) : true,
        );
      }

      validate(meta, resolved, deps, path);

      return true;
    },
  };
});

export default function validateBuiltins(
  api: PluginAPI,
  options: Record<string, unknown> = {},
  dirname: string,
): PluginObject {
  api.assertVersion("^7.4.0 || ^8.0.0");

  for (const name of Object.keys(options)) {
    if (!SUPPORTED_OPTIONS.has(name)) {
      throw new Error(`${PACKAGE_NAME} doesn't support the "${name}" option.`);
    }
  }

  return {
    // @babel/helper-define-polyfill-provider always calls the plugin
    // "inject-polyfills"
    ...provider(
      api,
      { ...options, method: "usage-global", missingDependencies: false },
      dirname,
    ),
    name: "validate-builtins",
  };
}
