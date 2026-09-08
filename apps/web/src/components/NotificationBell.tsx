'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/useApi';
import { post, get, ago, type NotificationFeed, type Notification } from '../lib/api';
import {
  Bell, Check, AlertTriangle, Info, CircleAlert, Settings2,
} from 'lucide-react';

/**
 * What has happened since you last looked.
 *
 * Polled rather than pushed: a websocket would mean a connection per open tab
 * held open all day for a handful of events, and this product's customers are
 * on connections where that is a real cost. A minute is soon enough for a bill
 * falling due.
 */
const POLL_MS = 60_000;

const ICON = { info: Info, warn: AlertTriangle, bad: CircleAlert };
const TONE = {
  info: 'text-slate-400',
  warn: 'text-amber-500',
  bad: 'text-rose-500',
};

/** Where tapping a notification should go. Routes, not URLs, from the server. */
function href(n: Notification): string {
  const l = n.link ?? {};
  switch (l.screen) {
    case 'voucher': return `/invoice/${l.id}`;
    case 'party': return `/parties/${encodeURIComponent(l.name ?? '')}`;
    case 'item': return `/items/${encodeURIComponent(l.name ?? '')}`;
    case 'txn': return `/txn/${l.section ?? 'sales'}`;
    case 'sync': return '/sync';
    default: return '/notifications';
  }
}

export default function NotificationBell() {
  const { company } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const feed = useApi<NotificationFeed>('/v1/notifications?limit=15', [], POLL_MS);

  /*
   * Look for the things nothing else reports.
   *
   * A voucher announces itself at ingest; a bill falling overdue does not -
   * nothing happens at the moment it becomes true. Asked once when the app
   * loads, which is the only time the answer matters.
   */
  useEffect(() => {
    if (!company) return;
    get(`/v1/companies/${encodeURIComponent(company.tallyGuid)}/notify-sweep`)
      .then(() => feed.reload())
      .catch(() => { /* a missed sweep is not worth surfacing */ });
    // Deliberately once per company, not on every feed change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.tallyGuid]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const unread = feed.data?.unread ?? 0;

  return (
    <div className="relative" ref={box}>
      <button onClick={() => setOpen(!open)}
        aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg
                   text-slate-500 transition hover:bg-slate-100 hover:text-slate-700">
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center
                           justify-center rounded-full bg-rose-600 px-1 text-[10px]
                           font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[360px] overflow-hidden rounded-xl
                        border border-line bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-semibold text-slate-800">
              {unread > 0 ? `${unread} new` : 'Notifications'}
            </span>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button onClick={async () => { await post('/v1/notifications/read', {}); feed.reload(); }}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700">
                  <Check size={12} /> Mark all read
                </button>
              )}
              <Link href="/notifications" onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600" aria-label="Notification settings">
                <Settings2 size={14} />
              </Link>
            </div>
          </div>

          <div className="max-h-[420px] overflow-auto">
            {!feed.data?.notifications.length ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                Nothing yet. New sales, overdue bills and sync problems appear here.
              </p>
            ) : feed.data.notifications.map((n) => {
              const I = ICON[n.level] ?? Info;
              return (
                <Link key={n.id} href={href(n)}
                  onClick={async () => {
                    setOpen(false);
                    await post('/v1/notifications/read', { ids: [Number(n.id)] });
                    feed.reload();
                  }}
                  className={`flex gap-2.5 border-b border-slate-50 px-4 py-2.5 transition
                              last:border-0 hover:bg-slate-50 ${n.read ? 'opacity-60' : ''}`}>
                  <I size={15} className={`mt-0.5 shrink-0 ${TONE[n.level]}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800">{n.title}</div>
                    {n.body && <div className="text-xs text-slate-500">{n.body}</div>}
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      {n.label} · {ago(n.at)}
                    </div>
                  </div>
                  {!n.read && (
                    <span className="ml-auto mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-600" />
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
