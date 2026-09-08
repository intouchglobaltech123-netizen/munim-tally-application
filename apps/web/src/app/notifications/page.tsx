'use client';

import { useApi } from '../../lib/useApi';
import { useMoney } from '../../lib/money';
import { post, patch, ago, type NotificationSettings, type NotificationFeed } from '../../lib/api';
import {
  Badge, Button, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  Bell, BellOff, Check, Info, Moon, AlertTriangle, CircleAlert,
} from 'lucide-react';

/**
 * Which events raise a notification, and when this person wants to be left
 * alone.
 *
 * The rules are the business's; the quiet hours are the person's. Mixing them
 * would mean one owner's bedtime silencing their accountant's morning.
 */

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const hourLabel = (h: number) =>
  h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`;

const ICON = { info: Info, warn: AlertTriangle, bad: CircleAlert };

export default function NotificationsPage() {
  const money = useMoney();
  const cfg = useApi<NotificationSettings>('/v1/notifications/settings', []);
  const feed = useApi<NotificationFeed>('/v1/notifications?limit=40', []);

  if (cfg.error) return <ErrorNote message={cfg.error} onRetry={cfg.reload} />;
  if (cfg.loading && !cfg.data) return <Spinner label="Loading…" />;
  if (!cfg.data) return null;

  const mine = cfg.data.mine;

  return (
    <>
      <PageTitle title="Notifications"
        subtitle="What Munim tells you about, and when it leaves you alone." />

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle icon={Moon}>Your quiet hours</SectionTitle>
          <Card className="mb-6">
            <p className="text-sm text-slate-600">
              Nothing between these hours. Your own setting — it does not affect anyone
              else on the account.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select value={mine.quietFrom}
                onChange={async (e) => {
                  await patch('/v1/notifications/mine', { quietFrom: Number(e.target.value) });
                  cfg.reload();
                }}
                className="rounded-lg border border-line px-3 py-2 text-sm">
                {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
              <span className="text-sm text-slate-500">to</span>
              <select value={mine.quietTo}
                onChange={async (e) => {
                  await patch('/v1/notifications/mine', { quietTo: Number(e.target.value) });
                  cfg.reload();
                }}
                className="rounded-lg border border-line px-3 py-2 text-sm">
                {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
              {mine.inQuietHoursNow && <Badge tone="warn">Quiet right now</Badge>}
            </div>

            <div className="mt-4">
              <Button variant={mine.muted ? 'primary' : 'ghost'}
                icon={mine.muted ? Bell : BellOff}
                onClick={async () => {
                  await patch('/v1/notifications/mine', { muted: !mine.muted });
                  cfg.reload();
                }}>
                {mine.muted ? 'Turn notifications back on' : 'Mute everything'}
              </Button>
            </div>
          </Card>

          <SectionTitle icon={Bell}>What raises a notification</SectionTitle>
          <div className="space-y-2">
            {cfg.data.rules.map((r) => {
              const I = ICON[r.level as keyof typeof ICON] ?? Info;
              return (
                <Card key={r.event} className={r.visibleToMe ? '' : 'opacity-60'}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 gap-2.5">
                      <I size={15} className={`mt-0.5 shrink-0 ${
                        r.level === 'bad' ? 'text-rose-500'
                          : r.level === 'warn' ? 'text-amber-500' : 'text-slate-400'}`} />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800">{r.label}</div>
                        <div className="text-xs text-slate-500">{r.hint}</div>
                        {!r.visibleToMe && (
                          <div className="mt-0.5 text-[11px] text-amber-700">
                            You would not see this one — it belongs to a section you
                            do not have access to.
                          </div>
                        )}
                        {r.minAmountPaise > 0 && (
                          <div className="mt-0.5 text-[11px] text-slate-400">
                            Only above {money(r.minAmountPaise)}
                          </div>
                        )}
                      </div>
                    </div>
                    <Button variant="ghost"
                      onClick={async () => {
                        await post('/v1/notifications/rules',
                          { event: r.event, enabled: !r.enabled,
                            minAmountPaise: r.minAmountPaise });
                        cfg.reload();
                      }}>
                      {r.enabled ? 'On' : 'Off'}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>

          <p className="mt-4 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                        text-xs text-slate-500">
            <Info size={13} className="mt-0.5 shrink-0" />
            {cfg.data.note}
          </p>
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <SectionTitle icon={Bell}>Everything so far</SectionTitle>
            {(feed.data?.unread ?? 0) > 0 && (
              <Button variant="ghost" icon={Check}
                onClick={async () => { await post('/v1/notifications/read', {}); feed.reload(); }}>
                Mark all read
              </Button>
            )}
          </div>

          {!feed.data?.notifications.length ? (
            <Empty title="Nothing yet" icon={Bell}
              hint="New sales, overdue bills and sync problems appear here." />
          ) : (
            <Card>
              {feed.data.notifications.map((n) => {
                const I = ICON[n.level] ?? Info;
                return (
                  <div key={n.id}
                    className={`flex gap-2.5 border-b border-slate-50 py-2.5 last:border-0 ${
                      n.read ? 'opacity-60' : ''}`}>
                    <I size={15} className={`mt-0.5 shrink-0 ${
                      n.level === 'bad' ? 'text-rose-500'
                        : n.level === 'warn' ? 'text-amber-500' : 'text-slate-400'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-800">{n.title}</div>
                      {n.body && <div className="text-xs text-slate-500">{n.body}</div>}
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {n.label} · {ago(n.at)}
                      </div>
                    </div>
                    {!n.read && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand-600" />}
                  </div>
                );
              })}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
