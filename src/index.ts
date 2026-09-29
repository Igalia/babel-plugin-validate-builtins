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

import type {
  File,
  NodePath,
  PluginAPI,
  PluginObject,
  types as t,
} from "@babel/core";
import { getInclusionReasons } from "@babel/helper-compilation-targets";

import defineProvider from "@babel/helper-define-polyfill-provider";

const PACKAGE_NAME = "@igalia/babel-plugin-validate-builtins";

const SUPPORTED_OPTIONS = new Set([
  "targets",
  "ignoreBrowserslistConfig",
  "configPath",
  "exclude",
  "proposals",
]);

type Options = {
  proposals?: boolean;
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

function compareVersions(a: string, b: string) {
  const aParts = a.split(".");
  const bParts = b.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = Number(aParts[i] ?? 0) - Number(bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const prettifyVersion = (version: string) => version.replace(/(\.0)+$/, "");

const provider = defineProvider<Options>(function (
  { createMetaResolver, shouldInjectPolyfill, targets },
  { proposals = true },
) {
  if (Object.keys(targets).length === 0) {
    throw new Error(
      `${PACKAGE_NAME}: could not find any target to validate against. ` +
        `Please specify your targets using the "targets" option.`,
    );
  }

  const resolve = createMetaResolver({
    global: BuiltIns,
    static: StaticProperties,
    instance: { ...CollectionInstanceProperties, ...InstanceProperties },
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
      const unsupported = getInclusionReasons(name, targets, corejs3Polyfills);
      for (const env of Object.keys(unsupported)) {
        const version = corejs3Polyfills[name][env];
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
    if (candidates.length === 0 || candidates.some(isSupported)) return;

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

    polyfills: corejs3Polyfills,

    filterPolyfills,

    pre() {
      violations = [];
      reportedNodes = new WeakSet();
    },

    post(file: File) {
      const fileViolations = violations;
      violations = reportedNodes = null;
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
          `${pronoun} by adding ${names} in brackets to the "exclude" ` +
          `option of ${PACKAGE_NAME}.`,
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
