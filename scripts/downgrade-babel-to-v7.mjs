// Adapted from babel-polyfills/scripts/downgrade-babel-to-v7.mjs

import { readFileSync, writeFileSync } from "node:fs";

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

// @babel/helper-define-polyfill-provider@1 supports both Babel 7 and 8
const exclude = new Set(["@babel/helper-define-polyfill-provider"]);

const babelPackages = [
  ...Object.keys(pkg.dependencies),
  ...Object.keys(pkg.devDependencies),
].filter(name => name.startsWith("@babel/") && !exclude.has(name));

// Add resolutions to force Babel 7
pkg.resolutions ??= {};
for (const name of babelPackages) {
  pkg.resolutions[name] = "^7.0.0";
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log("Added Babel 7 resolutions for:", babelPackages.sort().join(", "));
