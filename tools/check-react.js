#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Find (and optionally remove) duplicate copies of React.
 *
 * This workspace holds a React Native app beside a Next app, and Expo pins a
 * different React version, so npm regularly leaves nested copies behind:
 *
 *   node_modules/styled-jsx/node_modules/react   <- the one that actually bites
 *   node_modules/react-dom/node_modules/react
 *   node_modules/next/node_modules/react
 *
 * Two copies of React share no dispatcher, so the moment a hook runs through
 * the wrong one React throws
 *
 *   Cannot read properties of null (reading 'useInsertionEffect')
 *
 * reported as an invalid hook call, and every page of the web app returns 500.
 * styled-jsx is the usual culprit because Next bundles it and it is what calls
 * useInsertionEffect.
 *
 * Aliasing round it does not work - Turbopack reads resolveAlias values as
 * relative specifiers, so an absolute path resolves to nothing and breaks the
 * build far worse. The fix is to have one copy.
 *
 *   node tools/check-react.js         report
 *   node tools/check-react.js --fix   move the duplicates aside
 *
 * Run it after any npm install.
 */

const ROOT = path.join(__dirname, '..');
const FIX = process.argv.includes('--fix');

/** Every node_modules/react directory, without walking the whole disk. */
function find(dir, depth, out = []) {
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === 'react' && path.basename(dir) === 'node_modules') out.push(full);
    // Only descend through node_modules and package directories, never into
    // source trees - this runs on a Windows mount and every stat costs.
    if (e.name === 'node_modules' || path.basename(dir) === 'node_modules') {
      find(full, depth - 1, out);
    }
  }
  return out;
}

const found = find(path.join(ROOT, 'node_modules'), 4)
  .concat(find(path.join(ROOT, 'apps', 'web', 'node_modules'), 3));

const canonical = path.join(ROOT, 'node_modules', 'react');
const versionOf = (p) => {
  try { return require(path.join(p, 'package.json')).version; } catch { return '?'; }
};

/*
 * The mobile side is left alone on purpose.
 *
 * Expo is tested against the exact React it pins, and Metro bundles separately
 * from Next - a second copy under expo-sqlite is not a second copy in the WEB
 * bundle, and forcing them together is a change that belongs to whoever owns
 * the mobile build. Flagging them anyway would make this script cry wolf, and a
 * check that always complains is one nobody runs.
 */
const MOBILE_ONLY = /node_modules[\\/](@?expo[^\\/]*|react-native[^\\/]*|@react-native[^\\/]*)[\\/]/;

const duplicates = found.filter((p) =>
  p !== canonical
  && !p.includes(`${path.sep}apps${path.sep}mobile${path.sep}`)
  && !MOBILE_ONLY.test(p));

const mobileCopies = found.filter((p) => p !== canonical && MOBILE_ONLY.test(p));

console.log(`  canonical: ${versionOf(canonical)}  ${path.relative(ROOT, canonical)}`);

if (mobileCopies.length) {
  console.log(`  ${mobileCopies.length} copy(ies) under Expo packages — left alone, `
    + 'Metro bundles those separately');
}

if (!duplicates.length) {
  console.log('  no duplicate React in the web bundle — hooks will work');
  process.exit(0);
}

console.log(`\n  ${duplicates.length} duplicate copy(ies) that can break hooks:`);
for (const d of duplicates) {
  console.log(`    ${versionOf(d)}  ${path.relative(ROOT, d)}`);
}

if (!FIX) {
  console.log('\n  Run with --fix to move them aside.');
  process.exit(1);
}

for (const d of duplicates) {
  // Renamed rather than deleted: a package that genuinely needed its own copy
  // would fail loudly and the directory is still there to put back.
  const parked = `${d}.duplicate`;
  try {
    fs.rmSync(parked, { recursive: true, force: true });
    fs.renameSync(d, parked);
    console.log(`  moved aside: ${path.relative(ROOT, d)}`);
  } catch (e) {
    console.log(`  could not move ${path.relative(ROOT, d)}: ${e.message}`);
  }
}
console.log('\n  Done. Restart the dev server.');
