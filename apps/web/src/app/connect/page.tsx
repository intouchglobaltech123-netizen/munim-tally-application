'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { getToken, API, ago, type Devices } from '../../lib/api';
import { Card, PageTitle, Button, Spinner } from '../../components/ui';

/**
 * Connecting the computer that runs Tally.
 *
 * The whole page exists to protect one idea: the customer downloads a file and
 * double-clicks it. Nothing to type, no code to copy, no pairing screen. The
 * file the server builds already carries their account, so the steps below are
 * the entire install.
 *
 * The download has to come from fetch(), not a plain link, because it needs the
 * Authorization header - which is also why the file cannot be guessed or shared
 * usefully by anyone else.
 */
export default function ConnectPage() {
  const { me, loading } = useAuth();
  /*
   * Poll while waiting.
   *
   * After downloading, the customer walks to another computer and runs the
   * file. This page is what they come back to - so it has to answer "did it
   * work?" by itself, rather than asking them to refresh and guess.
   */
  const { data: devices } = useApi<Devices>('/v1/devices', [], 5000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function download() {
    setErr(null); setBusy(true);
    try {
      const res = await fetch(`${API}/v1/connector/installer`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? 'Could not prepare your setup file.');
      }

      // Give the file the name the server chose - it carries the business name,
      // so a customer with two shops can tell two downloads apart.
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const named = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'Munim-Setup.bat';

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = named;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;

  const live = (devices?.connectors ?? []).filter((c) => !c.revoked);
  const linked = live.length > 0;

  return (
    <>
      <PageTitle
        title="Connect your Tally"
        subtitle="One file, one double-click, on the computer where Tally runs."
      />

      {linked ? (
        <Card className="mb-5 border-brand-100 bg-brand-50">
          <p className="text-sm font-semibold text-brand-900">
            {live.length === 1 ? 'One computer is connected' : `${live.length} computers are connected`}
          </p>
          <ul className="mt-2 space-y-1">
            {live.map((c) => (
              <li key={c.id} className="text-sm text-brand-900">
                <b>{c.machine || 'Tally computer'}</b>
                {' · '}
                {c.tallyUp ? 'Tally is open' : 'Tally is closed'}
                {c.lastSeenAt ? ` · last heard from ${ago(c.lastSeenAt)}` : ''}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-brand-900/80">
            Use the steps below again only for another computer, or if you
            replaced this one.
          </p>
        </Card>
      ) : done ? (
        <Card className="mb-5 border-warn bg-warn-soft">
          <p className="text-sm font-semibold text-warn">Waiting for that computer…</p>
          <p className="mt-1 text-sm text-body">
            Run the file you downloaded on the machine where Tally is open. This
            page notices on its own — you do not need to refresh.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
        <Card>
          <ol className="space-y-5">
            <Step n={1} title="Open Tally on that computer">
              Press <b>F1</b> → <b>Settings</b> → <b>Connectivity</b> →{' '}
              <b>Client/Server configuration</b>. Set <b>Enable ODBC</b> to{' '}
              <b>Yes</b> and <b>Port</b> to <b>9000</b>, then press Enter through
              and <b>Ctrl+A</b> to save.
              <span className="mt-1.5 block text-xs text-muted">
                Leave <b>&quot;TallyPrime acts as&quot;</b> alone — that is a
                different feature and needs a Gold licence. Enable ODBC is the
                one that matters.
              </span>
            </Step>

            <Step n={2} title="Download your setup file">
              It is made for {me?.org?.name ? <b>{me.org.name}</b> : 'your business'} and
              works only for your account.
              <div className="mt-3">
                <Button onClick={download} disabled={busy}>
                  {busy ? 'Preparing…' : 'Download setup file'}
                </Button>
              </div>
              {done ? (
                <p className="mt-3 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-900">
                  Saved to your Downloads folder. If you are reading this on your
                  phone, send the file to the Tally computer — WhatsApp or email
                  is fine.
                </p>
              ) : null}
              {err ? (
                <p className="mt-3 rounded-lg bg-negative-soft px-3 py-2 text-xs text-negative">
                  {err}
                </p>
              ) : null}
            </Step>

            <Step n={3} title="Double-click it, and enter your licence key">
              A black window opens and asks you to press a key, then for your{' '}
              <b>licence key</b> — the <code className="rounded bg-line-soft px-1">
              MUNM-XXXX-XXXX-XXXX</code> code on your invoice.
              <span className="mt-1.5 block text-xs text-muted">
                Each key connects one computer, once. Keep Tally open while it
                runs — it takes under a minute.
              </span>
            </Step>

            <Step n={4} title="That is it">
              Your books appear here and on your phone, and stay up to date on
              their own — usually within a few seconds of you saving a voucher.
            </Step>
          </ol>
        </Card>

        <div className="space-y-5">
          <Card>
            <h3 className="text-sm font-semibold">If Windows warns you</h3>
            <p className="mt-2 text-sm text-body">
              Some computers show <b>&quot;Windows protected your PC&quot;</b>.
              Click <b>More info</b>, then <b>Run anyway</b>. That warning appears
              for any small publisher, not because anything is wrong.
            </p>
          </Card>

          <Card>
            <h3 className="text-sm font-semibold">What it can and cannot do</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-body">
              <li>✓ Reads your Tally data and sends it to your Munim account</li>
              <li>✓ Runs quietly in the background, starts itself after a restart</li>
              <li>✗ Never writes to, edits or deletes anything in Tally</li>
              <li>✗ Cannot see your Munim reports — it can only send</li>
            </ul>
            <p className="mt-3 text-xs text-muted">
              You can disconnect a computer at any time from{' '}
              <b>Devices</b>, and it stops immediately.
            </p>
          </Card>

          <Card>
            <h3 className="text-sm font-semibold">About your licence key</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-body">
              <li>It is on your Munim invoice</li>
              <li>One key connects <b>one</b> computer, and only once</li>
              <li>Setting up a second computer needs a second key</li>
            </ul>
            <p className="mt-3 text-xs text-muted">
              Lost your key, or replacing a computer? Contact Munim support and
              we will issue a new one.
            </p>
          </Card>

          <Card>
            <h3 className="text-sm font-semibold">Setting up more than one shop?</h3>
            <p className="mt-2 text-sm text-body">
              Download the file again on each computer, and use a separate
              licence key for each. Every book that Tally has open on a machine
              is picked up automatically, and you switch between them at the top
              of the dashboard.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function Step({ n, title, children }: {
  n: number; title: string; children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3.5">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full
                       bg-brand-700 text-xs font-bold text-white">
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="mt-1 text-sm text-body">{children}</div>
      </div>
    </li>
  );
}
