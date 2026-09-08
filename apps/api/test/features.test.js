const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../src/lib/features');

/**
 * Features decide what a customer has paid for, so the rules that matter are
 * the ones an edited client could otherwise get around.
 */

const org = (features = {}, extra = {}) => ({ features, ...extra });
const session = (o) => ({ org: o, user: { id: 'u' } });

test('a new customer gets the catalogue defaults', () => {
  const r = f.featuresFor(org());
  assert.equal(r.dashboard, true, 'the basics are on');
  assert.equal(r.reports, true);
  assert.equal(r.reminders, false, 'anything that costs money is off');
  assert.equal(r.multiCompany, false);
});

test('what is stored overrides the default, both ways', () => {
  const r = f.featuresFor(org({ reminders: true, reports: false }));
  assert.equal(r.reminders, true);
  assert.equal(r.reports, false);
});

test('an unknown key in the database is ignored, not trusted', () => {
  // Something left behind by an old build must not become a feature.
  const r = f.featuresFor(org({ superAdmin: true, reports: true }));
  assert.equal(r.superAdmin, undefined);
  assert.equal(Object.keys(r).length, f.catalogue().length);
});

test('a non-boolean value falls back to the default rather than being truthy', () => {
  // "yes", 1 and "false" are all truthy in JavaScript; none should enable a
  // paid feature.
  for (const junk of ['yes', 1, 'false', {}, []]) {
    assert.equal(f.featuresFor(org({ reminders: junk })).reminders, false,
      `${JSON.stringify(junk)} must not enable a paid feature`);
  }
});

test('a feature the customer does not have is refused with a 403', () => {
  try {
    f.requireFeature(session(org({ reminders: false })), 'reminders');
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 403);
    assert.equal(e.code, 'FEATURE_NOT_ENABLED');
    // 403 rather than 404: the feature exists, and saying so shortens the
    // support call.
    assert.match(e.message, /Contact Munim/);
  }
});

test('a feature the customer has passes', () => {
  assert.doesNotThrow(() => f.requireFeature(session(org({ reminders: true })), 'reminders'));
});

/*
 * Ceilings moved to lib/quotas.js against lib/plans.js, and are covered by
 * plans.test.js. They are not tested twice here: two places deciding a limit is
 * exactly how a pricing page ends up promising what the server refuses, and a
 * duplicate test would keep the dead path looking alive.
 */
test('this module no longer decides ceilings', () => {
  assert.equal(f.requireWithinLimit, undefined,
    'limits belong to lib/quotas.js — one place, or they drift');
});
