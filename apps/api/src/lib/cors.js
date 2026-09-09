'use strict';

/**
 * Which sites may call this API from a browser.
 *
 * CORS_ORIGIN takes a comma-separated list. An entry may start with a dot to
 * mean "this domain and anything under it", which is what makes a host like
 * Vercel usable at all: the same build is served from the project address AND
 * from a per-deployment address, and the browser sends whichever one it is on.
 *
 * The header has to echo the origin that ASKED, not the first one configured.
 * Answering every request with the same value looks right in curl - the header
 * is there, and it names a real site - and fails in a browser with "Failed to
 * fetch" and no other explanation, because the browser compares the value
 * against the page it is on. That is exactly how this failed on a deployment
 * URL while looking perfectly healthy from the command line.
 */

function parse(value) {
  return String(value || '*')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * The value for Access-Control-Allow-Origin, or null to send no header.
 *
 * Returning null rather than a wrong origin is deliberate: a browser treats a
 * missing header and a mismatched one the same way, and sending somebody
 * else's origin would be a quiet lie in a security header.
 */
function allowedOrigin(origin, rules) {
  if (rules.includes('*')) return '*';
  if (!origin) return null;

  const asked = String(origin).replace(/\/$/, '');
  let host;
  try {
    host = new URL(asked).hostname;
  } catch {
    return null;              // not something a browser would have sent
  }

  for (const rule of rules) {
    if (rule === asked) return asked;

    if (rule.startsWith('.')) {
      /*
       * ".vercel.app" means vercel.app and anything under it.
       *
       * Checked on the parsed hostname, not with endsWith on the whole string.
       * endsWith('.vercel.app') is false for "evil-vercel.app" but true for
       * "https://vercel.app.attacker.com/.vercel.app" style values, and more
       * to the point it would happily match a path or a port that happened to
       * end the right way. The hostname is the only part that decides this.
       */
      const bare = rule.slice(1);
      if (host === bare || host.endsWith(rule)) return asked;
    }
  }
  return null;
}

module.exports = { parse, allowedOrigin };
