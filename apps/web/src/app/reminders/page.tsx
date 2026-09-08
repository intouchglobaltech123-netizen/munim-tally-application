'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { useMoney } from '../../lib/money';
import {
  post, patch, put, ago,
  type ReminderWorklist, type ReminderConfig, type ReminderHistory, type ReminderJob,
} from '../../lib/api';
import {
  Badge, Button, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import { shareOnWhatsApp, shareByEmail, copyText } from '../../lib/share';
import {
  MessageCircle, Mail, Copy, Check, X, BellOff, Info, Clock3, CheckCircle2,
  Phone, Settings2, History, AlertTriangle,
} from 'lucide-react';

/**
 * Chasing money, one tap per customer.
 *
 * Munim decides who to chase and writes the message; the owner presses send in
 * their own WhatsApp. Every claim on this screen is careful about that
 * distinction, because a history that says "delivered" when nothing was
 * confirmed is worse than no history.
 */

const TABS = [
  { key: 'today', label: 'To chase' },
  { key: 'history', label: 'History' },
  { key: 'rules', label: 'Rules & messages' },
];

export default function RemindersPage() {
  const { company } = useAuth();
  const money = useMoney();
  const [tab, setTab] = useState('today');
  const [done, setDone] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const work = useApi<ReminderWorklist>(base && `${base}/reminders`, [company?.tallyGuid]);
  const hist = useApi<ReminderHistory>('/v1/reminders/history?limit=100', []);
  const cfg = useApi<ReminderConfig>('/v1/reminders/config', []);

  async function record(job: ReminderJob, status: string) {
    if (!base) return;
    setDone((d) => ({ ...d, [job.party]: status }));
    await post(`${base}/reminders/record`, {
      party: job.party, phone: job.phone, amountPaise: job.amountPaise,
      channel: job.channel, status,
      ruleId: job.rule.id, templateId: job.templateId,
      billRefs: job.bills.map((b) => b.ref),
      dueDate: job.bills[0]?.dueDate ?? '',
      daysOverdue: job.daysOverdue, message: job.message,
    });
    hist.reload();
  }

  async function optOut(party: string) {
    if (!base) return;
    await put(`${base}/reminders/party/${encodeURIComponent(party)}`, { noReminders: true });
    work.reload();
  }

  if (work.error) return <ErrorNote message={work.error} onRetry={work.reload} />;

  return (
    <>
      <PageTitle title="Reminders"
        subtitle={work.data ? `${work.data.totals.parties} to chase · ${money(work.data.totals.amountPaise)}` : ''} />

      <div className="mb-5 flex flex-wrap gap-1.5 border-b border-line pb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
              tab === t.key ? 'bg-brand-700 text-white'
                            : 'text-muted hover:bg-line-soft hover:text-ink'}`}>
            {t.label}
            {t.key === 'today' && work.data && work.data.totals.parties > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] text-white">
                {work.data.totals.parties}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'today' && (
        work.loading && !work.data ? <Spinner label="Working out who to chase…" />
          : !work.data?.worklist.length ? (
            <Empty title="Nobody to chase today" icon={CheckCircle2}
              hint="Either everything is current, or everyone due a reminder has had one recently." />
          ) : (
            <>
              <p className="mb-4 flex items-start gap-2 rounded-lg bg-brand-50 px-3 py-2
                            text-xs leading-relaxed text-brand-900">
                <Info size={13} className="mt-0.5 shrink-0" />
                {work.data.note}
              </p>

              {work.data.totals.unreachable > 0 && (
                <div className="mb-4 flex items-start gap-2.5 rounded-lg bg-amber-50 px-4 py-3
                                text-sm ring-1 ring-amber-200">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
                  <span className="text-amber-900">
                    <b>{work.data.totals.unreachable}</b> of these have no phone number in Tally.
                    You cannot WhatsApp them until somebody adds one.
                  </span>
                </div>
              )}

              <div className="space-y-3">
                {work.data.worklist.map((job) => (
                  <Card key={job.party} className={done[job.party] ? 'opacity-60' : ''}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-slate-900">{job.party}</span>
                          <Badge tone={job.daysOverdue > 30 ? 'bad' : job.daysOverdue > 0 ? 'warn' : 'ok'}>
                            {job.daysOverdue > 0 ? `${job.daysOverdue} days overdue` : 'due soon'}
                          </Badge>
                          {job.remindedBefore > 0 && (
                            <Badge tone="warn">chased {job.remindedBefore}×</Badge>
                          )}
                          {done[job.party] && <Badge tone="ok">{done[job.party]}</Badge>}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {job.bills.length} bill{job.bills.length === 1 ? '' : 's'} ·{' '}
                          {job.rule.name}
                          {job.phone ? ` · ${job.phone}` : ' · no phone on file'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-bold tabular-nums text-slate-900">
                          {money(job.amountPaise)}
                        </div>
                      </div>
                    </div>

                    <button onClick={() => setOpen(open === job.party ? null : job.party)}
                      className="mt-3 w-full rounded-lg bg-slate-50 p-3 text-left text-xs
                                 leading-relaxed text-slate-700 hover:bg-slate-100">
                      {open === job.party
                        ? job.message.split('\n').map((l, i) => <div key={i}>{l || ' '}</div>)
                        : <span className="line-clamp-2">{job.message}</span>}
                    </button>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button icon={MessageCircle}
                        disabled={!job.reachable}
                        onClick={() => {
                          shareOnWhatsApp(job.message, job.phone);
                          record(job, 'handed-off');
                        }}>
                        WhatsApp
                      </Button>
                      {job.email && (
                        <Button variant="ghost" icon={Mail}
                          onClick={() => {
                            shareByEmail(`Payment reminder from ${work.data!.company.name}`,
                              job.message, job.email);
                            record(job, 'handed-off');
                          }}>
                          Email
                        </Button>
                      )}
                      <Button variant="ghost" icon={Copy}
                        onClick={() => { copyText(job.message); record(job, 'handed-off'); }}>
                        Copy
                      </Button>
                      <Button variant="ghost" icon={Check}
                        onClick={() => record(job, 'sent')}>
                        Mark sent
                      </Button>
                      <Button variant="ghost" icon={X}
                        onClick={() => record(job, 'skipped')}>
                        Skip
                      </Button>
                      <Button variant="ghost" icon={BellOff} onClick={() => optOut(job.party)}>
                        Never chase
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </>
          )
      )}

      {tab === 'history' && (
        hist.loading && !hist.data ? <Spinner /> : (
          <>
            {hist.data && (
              <>
                <div className="mb-4 grid gap-3 sm:grid-cols-4">
                  <Stat label="Chased" value={String(hist.data.last90Days.total)} sub="in 90 days" />
                  <Stat label="Confirmed sent" value={String(hist.data.last90Days.sent)} sub="" />
                  <Stat label="Skipped" value={String(hist.data.last90Days.skipped)} sub="" />
                  <Stat label="Settled after" value={String(hist.data.last90Days.settledAfterReminder)}
                    sub="parties" />
                </div>
                <p className="mb-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                              text-xs text-slate-500">
                  <Info size={13} className="mt-0.5 shrink-0" />
                  {hist.data.last90Days.caveat}
                </p>
              </>
            )}
            {!hist.data?.reminders.length ? (
              <Empty title="Nothing chased yet" icon={History}
                hint="Reminders you send appear here." />
            ) : (
              <Card>
                <table className="w-full text-sm">
                  <tbody>
                    {hist.data.reminders.map((r) => (
                      <tr key={r.id} className="border-b border-slate-50 last:border-0">
                        <td className="py-2 pr-3">
                          <div className="font-medium text-slate-800">{r.party}</div>
                          <div className="text-[11px] text-slate-400">
                            {ago(r.at)}{r.by ? ` · ${r.by}` : ''}
                            {r.billRefs.length ? ` · ${r.billRefs.slice(0, 3).join(', ')}` : ''}
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          <Badge tone={r.status === 'sent' ? 'ok'
                            : r.status === 'skipped' ? 'warn' : 'ok'}>
                            {r.status}
                          </Badge>
                        </td>
                        <td className="py-2 text-right tabular-nums font-semibold">
                          {money(r.amountPaise)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )
      )}

      {tab === 'rules' && (
        cfg.loading && !cfg.data ? <Spinner /> : (
          <>
            <SectionTitle icon={Clock3}>When to chase</SectionTitle>
            <div className="mb-6 space-y-2">
              {cfg.data?.rules.map((r) => (
                <Card key={r.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900">{r.name}</span>
                        <Badge tone={r.enabled ? 'ok' : 'warn'}>
                          {r.enabled ? 'On' : 'Off'}
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {r.trigger === 'before' ? `${r.days} days before due`
                          : r.trigger === 'on' ? 'On the due date'
                          : `${r.days} days after due`}
                        {' · '}uses “{r.templateName}”
                        {' · '}at most {r.maxReminders}, {r.repeatDays} days apart
                        {r.minAmountPaise > 0 && ` · only above ${money(r.minAmountPaise)}`}
                      </div>
                    </div>
                    <Button variant="ghost"
                      onClick={async () => {
                        await patch(`/v1/reminders/rules/${r.id}`, { enabled: !r.enabled });
                        cfg.reload(); work.reload();
                      }}>
                      {r.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>

            <SectionTitle icon={Settings2}>Messages</SectionTitle>
            <div className="space-y-3">
              {cfg.data?.templates.map((t) => (
                <TemplateCard key={t.id} t={t}
                  placeholders={cfg.data!.placeholders}
                  onSaved={() => { cfg.reload(); work.reload(); }} />
              ))}
            </div>
          </>
        )
      )}
    </>
  );
}

function TemplateCard({ t, placeholders, onSaved }: {
  t: ReminderConfig['templates'][number];
  placeholders: ReminderConfig['placeholders'];
  onSaved: () => void;
}) {
  const [body, setBody] = useState(t.body);
  const [busy, setBusy] = useState(false);
  const dirty = body !== t.body;

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-semibold text-slate-900">{t.name}</span>
        {dirty && (
          <Button disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await patch(`/v1/reminders/templates/${t.id}`, { name: t.name, body });
                onSaved();
              } finally { setBusy(false); }
            }}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7}
        className="w-full rounded-lg border border-line p-3 font-mono text-xs
                   outline-none focus:border-brand-500" />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {placeholders.map((p) => (
          <button key={p.key} title={p.what}
            onClick={() => setBody((b) => `${b}{{${p.key}}}`)}
            className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600
                       hover:bg-slate-200">
            {`{{${p.key}}}`}
          </button>
        ))}
      </div>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </Card>
  );
}
