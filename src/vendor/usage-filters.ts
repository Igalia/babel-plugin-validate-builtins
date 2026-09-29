// Vendored from babel-plugin-polyfill-corejs3
// https://github.com/babel/babel-polyfills/blob/6e327937ea1155242de55858192dca0bb80e0a74/packages/babel-plugin-polyfill-corejs3/src/usage-filters.ts

import type { CoreJSPolyfillDescriptor } from "./built-in-definitions.ts";
import { types as t, type NodePath } from "@babel/core";

export default function canSkipPolyfill(
  desc: CoreJSPolyfillDescriptor,
  path: NodePath,
) {
  const { node, parent } = path;
  switch (desc.name) {
    case "es.string.split": {
      if (!t.isCallExpression(parent, { callee: node })) return false;
      if (parent.arguments.length < 1) return true;
      const splitter = parent.arguments[0];
      return t.isStringLiteral(splitter) || t.isTemplateLiteral(splitter);
    }
  }
}
