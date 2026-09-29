// Usage: node scripts/sync-vendored.mjs <babel-polyfills commit>
//
// Downloads the files that this plugin shares with
// babel-plugin-polyfill-corejs3 from the given babel-polyfills commit.

import fs from "node:fs";

const FILES = ["built-in-definitions", "usage-filters"];

const ref = process.argv[2];
if (!ref) {
  console.error(
    "Usage: node scripts/sync-vendored.mjs <babel-polyfills commit>"
  );
  process.exit(1);
}

for (const name of FILES) {
  const path = `packages/babel-plugin-polyfill-corejs3/src/${name}.ts`;
  const url = `https://raw.githubusercontent.com/babel/babel-polyfills/${ref}/${path}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);

  const source = (await res.text()).replace(
    /from "\.\/([\w-]+)"/g,
    'from "./$1.ts"'
  );

  fs.writeFileSync(
    new URL(`../src/vendor/${name}.ts`, import.meta.url),
    `// Vendored from babel-plugin-polyfill-corejs3\n` +
      `// https://github.com/babel/babel-polyfills/blob/${ref}/${path}\n\n` +
      source
  );
}
