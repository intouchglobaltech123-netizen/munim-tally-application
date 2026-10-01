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
  /*
   * Approving a code typed on the Tally PC.
   *
   * The .bat carries its own code, so this is never needed for that route. The
   * plain script cannot carry one - it is the same file for every customer, so
   * that it can be signed - and asks the cloud for a code instead. Somebody has
   * to say yes to that code, and making them reach for their phone to do it
   * would be a poor answer when they are already signed in here.
   */
  const [code, setCode] = useState('');
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [approveErr, setApproveErr] = useState<string | null>(null);

  /*
   * The same steps, as plain text.
   *
   * The person who has to do this is usually not the person reading this page:
   * it is whoever sits at the shop computer, reached over WhatsApp. Reading
   * five steps down a phone call is how they get done wrong, so they are
   * copyable instead.
   */
  const STEPS = [
    'Munim setup on the Tally computer',
    '',
    '1. Open K7 (or Quick Heal) > Settings > Real Time Protection',
    '   > Click Here to Manage Exclusions.',
    '2. Add Entry > Add Folder > C:\\ProgramData\\Munim',
    '   Tick "Include Subfolders", then OK.',
    '   Do the same for the Downloads folder.',
    '3. Open the Munim website > Connect your Tally >',
    '   "Download the plain script (.ps1)".',
    '4. Click Start, type powershell, press Enter, then paste this line:',
    '',
    '   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\Downloads\\Munim-Connector.ps1" setup',
    '',
    '5. Type the licence key when it asks (MUNM-XXXX-XXXX-XXXX).',
    '6. It shows a code. Send me that code and I will approve it.',
    '',
    'Keep Tally open while this runs. Munim only reads Tally -',
    'it cannot change or delete anything in your books.',
  ].join('\n');

  const [copied, setCopied] = useState(false);

  async function copySteps() {
    try {
      await navigator.clipboard.writeText(STEPS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard refused (an insecure origin, or an old browser). Selecting
      // the text by hand still works, so this is not worth an error message.
    }
  }

  async function approve() {
    setApproveErr(null); setApproving(true);
    try {
      const res = await fetch(`${API}/v1/auth/intent/approve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getToken() ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ intentId: code.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? 'That code could not be approved.');
      setApproved(true); setCode('');
    } catch (e) {
      setApproveErr((e as Error).message);
    } finally {
      setApproving(false);
    }
  }

  async function download(format?: 'ps1') {
    setErr(null); setBusy(true);
    try {
      const res = await fetch(
        `${API}/v1/connector/installer${format ? `?format=${format}` : ''}`, {
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
                <Button onClick={() => download()} disabled={busy}>
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
          {/*
            * The antivirus card.
            *
            * K7 quarantined the .bat on a real customer's machine, and a shop
            * owner who sees "Suspicious Object - Quarantined" stops there and
            * rings us. Telling them to switch their antivirus off would be
            * advice we should not give, so the second route is a file that does
            * not look like a dropper: the script itself, run by Windows' own
            * menu item.
            */}
          <Card className="border-warn/40">
            <h3 className="text-sm font-semibold">If your antivirus blocks the file</h3>
            <p className="mt-2 text-sm text-body">
              Some antivirus programs (K7 and Quick Heal especially) quarantine
              any <code className="rounded bg-line-soft px-1">.bat</code> file
              that starts PowerShell, whoever made it. Use the plain script
              instead — same setup, nothing for them to object to.
            </p>
            <div className="mt-3">
              <Button variant="ghost" onClick={() => download('ps1')} disabled={busy}>
                {busy ? 'Preparing…' : 'Download the plain script (.ps1)'}
              </Button>
            </div>
            <ol className="mt-3 space-y-1.5 text-sm text-body">
              <li>1. Save it on the Tally computer.</li>
              <li>
                2. <b>Right-click</b> the file → <b>Run with PowerShell</b>.
                Do not double-click it: that opens Notepad.
              </li>
              <li>3. Enter your licence key when it asks.</li>
              <li>
                4. It shows a <b>code</b>. Type that code below, or scan it in
                the phone app.
              </li>
            </ol>

            <div className="mt-3 flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="int_xxxxxxxxxxxx"
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2
                           text-sm text-ink placeholder:text-faint
                           focus:border-brand-600 focus:outline-none"
              />
              <Button variant="ghost" onClick={approve} disabled={approving || !code.trim()}>
                {approving ? 'Approving…' : 'Approve'}
              </Button>
            </div>
            {approved ? (
              <p className="mt-2 text-xs text-positive">
                Approved. That computer connects within a few seconds.
              </p>
            ) : null}
            {approveErr ? (
              <p className="mt-2 text-xs text-negative">{approveErr}</p>
            ) : null}
            <details className="mt-4 rounded-lg border border-line bg-canvas p-3">
              <summary className="cursor-pointer text-sm font-semibold">
                Running K7 or Quick Heal? Do this first
              </summary>
              <p className="mt-2 text-sm text-body">
                They quarantine this kind of file on sight, whoever made it.
                Allow the folder before you download and the install just works:
              </p>
              <ol className="mt-2 space-y-1 text-sm text-body">
                <li>
                  1. Open <b>K7</b> → <b>Settings</b> → <b>Real Time
                  Protection</b> → <b>Click Here to Manage Exclusions</b>.
                </li>
                <li>
                  2. <b>Add Entry</b> → <b>Add Folder</b> →{' '}
                  <code className="rounded bg-line-soft px-1">C:\ProgramData\Munim</code>,
                  tick <b>Include Subfolders</b>, then <b>OK</b>.
                </li>
                <li>
                  3. Do the same for your <b>Downloads</b> folder, then download
                  again.
                </li>
              </ol>
              <p className="mt-2 text-sm text-body">
                Already taken? <b>Reports</b> → <b>Quarantine Manager</b> →
                select the Munim file → <b>Restore</b>.
              </p>
              <p className="mt-2 text-xs text-muted">
                Quick Heal is the same idea: Settings → Exclude Files &amp;
                Folders. Munim only ever reads Tally — it cannot change your
                books, and you can disconnect it from <b>Devices</b> at any time.
              </p>

              <div className="mt-3 flex items-center gap-2">
                <Button variant="ghost" onClick={copySteps}>
                  {copied ? 'Copied' : 'Copy these steps'}
                </Button>
                <span className="text-xs text-muted">
                  Send them to whoever is at the Tally computer.
                </span>
              </div>
            </details>
          </Card>

          {/*
            * The way out when the Tally PC's antivirus will not be reasoned
            * with at all.
            *
            * Tally's gateway listens on the network, not only on its own
            * machine, so the connector does not have to live on the computer
            * that runs Tally. Put it on any other Windows machine on the same
            * network and the protected PC has nothing installed on it, nothing
            * downloaded to it, and nothing for its antivirus to object to.
            */}
          <Card>
            <h3 className="text-sm font-semibold">
              If that computer still refuses
            </h3>
            <p className="mt-2 text-sm text-body">
              Munim does not have to run on the Tally computer. It can run on
              any other Windows computer on the same network and read Tally
              across it. Nothing is installed on the Tally machine at all.
            </p>
            <ol className="mt-3 space-y-1.5 text-sm text-body">
              <li>
                1. On the <b>Tally computer</b>: Start → type{' '}
                <code className="rounded bg-line-soft px-1">cmd</code> → run{' '}
                <code className="rounded bg-line-soft px-1">ipconfig</code> and
                note the <b>IPv4 Address</b>, e.g. 192.168.1.50. Leave Tally
                open.
              </li>
              <li>
                2. Still there, allow the port once, in an{' '}
                <b>Administrator</b> command window:
                <code className="mt-1 block overflow-x-auto rounded bg-line-soft px-2 py-1 text-xs">
                  netsh advfirewall firewall add rule name=&quot;Tally
                  gateway&quot; dir=in action=allow protocol=TCP localport=9000
                </code>
                <span className="mt-1 block text-xs text-muted">
                  If K7 runs its own firewall, allow port 9000 there too.
                </span>
              </li>
              <li>
                3. On the <b>other computer</b>: download the plain script and
                run it, pointing at that address:
                <code className="mt-1 block overflow-x-auto rounded bg-line-soft px-2 py-1 text-xs">
                  powershell -ExecutionPolicy Bypass -File
                  &quot;$env:USERPROFILE\Downloads\Munim-Connector.ps1&quot;
                  setup -Tally http://192.168.1.50:9000
                </code>
              </li>
            </ol>
            <p className="mt-3 text-xs text-muted">
              That second computer has to be switched on for syncing to
              continue, and both must be on the same office network. Any
              ordinary Windows PC or laptop will do.
            </p>
          </Card>

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
