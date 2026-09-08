'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button } from '../../components/ui';

/**
 * Naming the business IS creating the company. Everything else — the Tally
 * link, the books, the reminders — hangs off this one record, which is why it
 * is the first thing asked and why nothing else is reachable until it is done.
 */
export default function OnboardingPage() {
  const { me, refresh } = useAuth();
  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function create() {
    setErr(null); setBusy(true);
    try {
      await post('/v1/onboarding', { businessName, ownerName });
      await refresh();
      router.replace('/');
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-brand-800 to-brand-600 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-7 shadow-xl">
        <div className="mb-1 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-700 text-lg font-extrabold text-white">M</span>
          <span className="text-xl font-bold tracking-tight">Munim</span>
        </div>
        <h1 className="mt-5 text-xl font-bold">What is your business called?</h1>
        <p className="mt-1 text-sm text-muted">
          This is the name you will see on your dashboard, and the name your
          customers see on payment reminders.
        </p>

        <label className="mt-6 mb-1.5 block text-sm font-semibold" htmlFor="biz">
          Business name
        </label>
        <input
          id="biz" autoFocus value={businessName} maxLength={80}
          placeholder="Your shop or company name"
          onChange={(e) => setBusinessName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && businessName.trim().length >= 2) void create(); }}
          className="w-full rounded-xl border-2 border-line px-3 py-3 text-base outline-none focus:border-brand-600"
        />

        <label className="mt-4 mb-1.5 block text-sm font-semibold" htmlFor="owner">
          Your name <span className="font-normal text-faint">(optional)</span>
        </label>
        <input
          id="owner" value={ownerName} maxLength={60} placeholder="Ramesh"
          onChange={(e) => setOwnerName(e.target.value)}
          className="w-full rounded-xl border-2 border-line px-3 py-3 text-base outline-none focus:border-brand-600"
        />

        {err ? <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</p> : null}

        <Button onClick={create} disabled={busy || businessName.trim().length < 2}
          className="mt-6 w-full">
          {busy ? 'Creating…' : 'Create my business'}
        </Button>

        <p className="mt-4 text-xs text-faint">
          Signed in as {me?.user.phone}. Next you will link the computer that runs Tally.
        </p>
      </div>
    </div>
  );
}
