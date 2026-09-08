import { pgTable, uuid, text, timestamp, boolean, integer, jsonb } from 'drizzle-orm/pg-core';

export const reminders = pgTable('reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  ledgerId: uuid('ledger_id').notNull(),
  billId: uuid('bill_id'), // can be null if it's a general statement
  channel: text('channel').notNull(), // whatsapp | sms | email
  templateKey: text('template_key').notNull(),
  status: text('status').notNull().default('queued'), // queued | sent | delivered | read | failed
  providerMsgId: text('provider_msg_id'),
  error: text('error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const reminderRules = pgTable('reminder_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  enabled: boolean('enabled').default(false),
  daysAfterDue: jsonb('days_after_due').default([7, 15, 30]), // e.g. [7, 15, 30]
  channels: jsonb('channels').default(['whatsapp']), // e.g. ['whatsapp', 'sms']
  sendAt: text('send_at').default('10:00'), // IST time
  templateKey: text('template_key').notNull(),
});

export const messageCredits = pgTable('message_credits', {
  orgId: uuid('org_id').primaryKey(),
  balance: integer('balance').default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
