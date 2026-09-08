// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

/*
 * In a monorepo Metro walks up to the workspace root and then tries to crawl
 * every file under it - including apps/web/node_modules, which on Windows means
 * thousands of pnpm symlinks. Some of those cannot be lstat'ed (EPERM/UNKNOWN),
 * and the crawler does not skip them: it emits an error event that takes the
 * whole bundler down before Metro ever starts.
 *
 * The app never imports anything from the web or api workspaces, so watching
 * them buys nothing. Name the two roots it actually needs.
 */
config.watchFolders = [
  projectRoot,
  path.resolve(workspaceRoot, 'node_modules'),
];

// Resolve from the app first, then the hoisted workspace store.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Belt and braces: even reached by another path, these are never bundled.
config.resolver.blockList = [
  /[\\/]apps[\\/]web[\\/]node_modules[\\/].*/,
  /[\\/]apps[\\/]api[\\/]node_modules[\\/].*/,
  /[\\/]connector[\\/].*/,
];

// pnpm links packages rather than copying them, so Metro must follow symlinks.
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
