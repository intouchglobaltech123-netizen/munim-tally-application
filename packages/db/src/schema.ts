import { pgTable, uuid, text, timestamp, boolean, numeric, bigint, date, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('trial'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => orgs.id),
  connectorId: uuid('connector_id'), // ref to connectors
  tallyGuid: text('tally_guid').notNull(),
  name: text('name').notNull(),
  fyStart: date('fy_start'),
  lastMasterAlterId: bigint('last_master_alterid', { mode: 'number' }).default(0),
  lastVoucherAlterId: bigint('last_voucher_alterid', { mode: 'number' }).default(0),
}, (t) => ({
  unq: uniqueIndex('unq_company_guid').on(t.orgId, t.tallyGuid)
}));

export const ledgers = pgTable('ledgers', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').references(() => companies.id),
  guid: text('guid').notNull(),
  name: text('name').notNull(),
  parentGroup: text('parent_group'),
  primaryGroup: text('primary_group'),
  openingBal: numeric('opening_bal', { precision: 18, scale: 2 }),
  closingBal: numeric('closing_bal', { precision: 18, scale: 2 }),
  phone: text('phone'),
  alterId: bigint('alter_id', { mode: 'number' }),
  isDeleted: boolean('is_deleted').default(false),
}, (t) => ({
  unq: uniqueIndex('unq_ledger_guid').on(t.companyId, t.guid),
  alterIdIdx: index('idx_ledger_alterid').on(t.companyId, t.alterId)
}));

export const vouchers = pgTable('vouchers', {
  id: uuid('id').defaultRandom(),
  companyId: uuid('company_id').notNull(),
  guid: text('guid').notNull(),
  vchNo: text('vch_no'),
  vchType: text('vch_type'),
  vchTypeParent: text('vch_type_parent'),
  vchDate: date('vch_date').notNull(),
  partyLedgerId: uuid('party_ledger_id'),
  amount: numeric('amount', { precision: 18, scale: 2 }),
  isCancelled: boolean('is_cancelled').default(false),
  isDeleted: boolean('is_deleted').default(false),
  alterId: bigint('alter_id', { mode: 'number' }),
  raw: jsonb('raw'),
  syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  // Note: Partitioning logic will be applied in migration
  pk: uniqueIndex('pk_vouchers').on(t.companyId, t.vchDate, t.guid),
  unq: uniqueIndex('unq_voucher_guid').on(t.companyId, t.guid),
  alterIdIdx: index('idx_voucher_alterid').on(t.companyId, t.alterId)
}));
