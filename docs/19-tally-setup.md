# 19 — Setting up Tally for testing

You need one company in Tally with some data in it. This takes about 3 minutes.

---

## Step 1 — Turn on the connection (once)

In Tally press **F1** → **Settings** → **Connectivity** → **Client/Server configuration**

```
TallyPrime acts as  :  None      <-- leave it. See the note below.
Enable ODBC         :  Yes       <-- this is the one that matters
Port                :  9000
```

Press **Enter** through to accept, then **Ctrl+A** to save.

> **"TallyPrime acts as" only offers "None" — is that a problem?**
>
> No. That setting is Tally's *multi-user data sharing*, which needs a Gold
> licence. It is **not** what Munim uses.
>
> **`Enable ODBC = Yes`** is what opens the gateway Munim reads. Confirmed
> working on your machine: a request to `http://localhost:9000` returned valid
> Tally XML with "acts as" set to None.

Check it from PowerShell:
```powershell
Get-NetTCPConnection -LocalPort 9000 -State Listen
```
A row means Tally is sharing. Nothing means it is not.

---

## Step 2 — Create a company

**Tally cannot create a company over the API** — it answers
`Could not find Company ''`. This one step has to be done in Tally's own screen.

From the Tally home screen:

1. Press **Alt + K** → **Create** *(or on the Gateway: Company → Create Company)*
2. **Company Name** — type anything, e.g. `Munim Test Traders`
3. **Financial year beginning from** — press Enter to accept the default
4. **Books beginning from** — press Enter
5. Leave everything else as-is
6. Press **Ctrl + A** to save
7. Say **Yes** if it asks to open the company

**Leave Tally open with this company loaded.** Munim can only read a company
that is currently open.

Check it:
```bash
lkp-agent check --tally http://<host>:9000
```
```
[  OK  ] Tally connection enabled   Connected at http://...:9000
[  OK  ] Company open in Tally      1 open
```

---

## Step 3 — Put data in it

You do not have to type vouchers by hand:

```bash
node tools/seed-tally.js --tally http://172.21.128.1:9000
```

It creates 8 customer ledgers (bill-wise on), a Sales ledger, stock items,
sales invoices across the last 5 months each with a bill reference, and receipts
against about a third of them — so **outstanding looks like a real book**
instead of every invoice ever raised.

> ⚠️ **This tool writes to Tally.** The Munim connector never does — that is
> enforced by a test (`TestNoRequestCanWriteToTally`). `tools/seed-tally.js` is
> a separate developer tool, deliberately kept outside `connector/`. Point it
> only at a test company you created. Never at real books.

### Educational mode

Without a licence, TallyPrime runs in **Educational mode** and only accepts
vouchers dated the **1st, 2nd or 31st** of a month. The seeding tool only ever
generates those dates, so it works without a licence.

Everything Munim needs — reading ledgers, vouchers, bills, outstanding — works
fine in Educational mode.

---

## Step 4 — Sync it

```bash
lkp-agent sync --tally http://172.21.128.1:9000
```

Then open the web app and your real Tally data is there.

---

## If you are running the connector from WSL

Smart App Control blocks unsigned binaries on Windows (see
[17-running.md](17-running.md)), so the practical development path is to run the
connector from WSL against Windows Tally.

WSL cannot reach Windows on `localhost` — use the host IP:

```bash
HOSTIP=$(ip route show default | awk '{print $3}')   # e.g. 172.21.128.1
echo $HOSTIP

cd connector && go build -o /tmp/lkp ./cmd/lkp-agent
/tmp/lkp check   --tally "http://$HOSTIP:9000"
/tmp/lkp setup   --tally "http://$HOSTIP:9000"
/tmp/lkp sync    --tally "http://$HOSTIP:9000"
```

**The host IP changes when you reboot**, so read it each time rather than
hardcoding it.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `port 9000: not listening` | Tally is closed, or Enable ODBC is not Yes. Step 1 |
| `No company is open in Tally` | Create one and keep it open. Step 2 |
| `Could not find Company ''` | You tried to create a company over the API. Not possible — use Tally's screen |
| Vouchers rejected during seeding | Educational mode: only the 1st, 2nd and 31st are allowed |
| WSL cannot reach `localhost:9000` | Use the host IP, not localhost |
