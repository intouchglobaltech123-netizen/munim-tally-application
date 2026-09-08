import type { NextConfig } from 'next';

/*
 * Deliberately almost empty, and both of the things that were here are gone for
 * reasons worth recording.
 *
 * 1. NO react/react-dom ALIAS.
 *
 *    This workspace holds a React Native app, and Expo pins react 19.1.0 while
 *    this app is on 19.2.8, so npm hoisted two copies and hooks broke with
 *    "Cannot read properties of null (reading 'useInsertionEffect')".
 *
 *    Aliasing looked like the fix and was worse. Turbopack reads resolveAlias
 *    values as RELATIVE specifiers, so an absolute path came back as
 *    "./mnt/c/.../node_modules/react" and resolved to nothing - every page in
 *    the app returned 500. Moving the alias to webpack only then stopped Next
 *    from starting at all, because Next 16 refuses a webpack config with no
 *    turbopack config beside it.
 *
 *    The duplicate is fixed where it actually lives: one react in the workspace,
 *    at the version react-dom expects, so there is nothing to disambiguate. If
 *    `npm install` ever reintroduces a second copy, the symptom is an invalid
 *    hook call and the fix is to remove the nested one - not to alias round it.
 *
 * 2. NO distDir OVERRIDE by default.
 *
 *    Kept as an opt-in because this project lives on the Windows filesystem,
 *    which WSL sees over a 9p mount that does not implement POSIX file locking.
 *    Turbopack takes a lockfile before doing anything, so `next dev` from inside
 *    WSL dies with "Permission denied" - which reads like a permissions problem
 *    and is not one; touch in the same directory succeeds.
 *
 *        NEXT_DIST_DIR=/tmp/munim-next npm run dev
 *
 *    Unset, it is the ordinary .next, so running from Windows is unchanged.
 */
const nextConfig: NextConfig = {
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
