# 24 — Manual test, end to end

A clean run through everything a real customer touches: sign in, buy a licence,
connect Tally, see the books, and the rules that protect it.

Start from an empty database. Nothing here uses demo data — every figure comes
from your own Tally.

---

## Before you start

| | |
|---|---|
| Postgres | running in WSL |
| Tally | open on this machine, with a company loaded |
| Phone | on the same Wi-Fi |

Tally's gateway must be on: **F1 → Settings → Connectivity → Client/Server
configuration**, `Enable ODBC = Yes`, port `9000`. Leave *"TallyPrime acts as"*
alone — that is a different feature needing a Gold licence.

---

## 0. Clear and start

```powershell
npm run db:reset          # shows what would go, changes nothing
npm run db:reset:yes      # actually clears it
```

Then, one terminal each:

```powershell
npm run api               # port 8080
npm run web               # port 3000
```

Check the server agrees it is ready:

```powershell
npm run auth:check
```

Five green ticks, ending in **Ready.** If not, it names the fix.

---

## 1. Sign in — expect a brand-new account

Open <http://localhost:3000> → **Continue with Google**.

| Expect | Why it matters |
|---|---|
| Google's account chooser appears | `prompt=select_account`, so a business and personal account cannot be confused |
| You land on **"What is your business called?"** | The database is empty, so this is a first sign-in |
| Not a dashboard | An account with no business name has nothing to show |

Name your business. You reach the dashboard, which says **one step left:
connect Tally**.

```bash
# what the server recorded
npm run db
select o.name, u.email, s.device_kind from sessions s
  join users u on u.id = s.user_id join orgs o on o.id = u.org_id;
```

`device_kind` should be `web`, and `expires_at` should be **null** — sessions do
not expire.

---

## 2. You are already staff

No SQL needed. `apps/api/.env` lists the staff accounts:

```
MUNIM_OPERATOR_EMAILS=arularul001k@gmail.com
```

Keyed on **email**, because sign-in is Google — an operator row with only a
phone number could never be signed into, which is how the admin area became
unreachable when SMS was removed. The API prints who is staff at startup:

```
staff sign-in: arularul001k@gmail.com
```

Listing an address also promotes an account that already exists, so you can sign
up as a customer first and become staff afterwards. Adding a colleague is one
comma and a restart.

Reload the web app. **Businesses**, **Licences**, **Fleet** and **Platform**
appear in the sidebar.

---

## 2a. Decide what this customer gets

**Admin → Businesses** → click a business → **Edit**.

Tick what they have paid for, set how many computers and books they may have,
set the plan, add a private note. **Save changes.**

| Expect | Why |
|---|---|
| Reminders is off by default | It spends message credits |
| Multiple companies is off | It implies a larger plan |
| Dashboard, Outstanding, Reports are on | Without them there is no product |
| Saving takes effect immediately | No restart, nothing reinstalled on their side |

**Test that it is real, not just hidden.** Turn **WhatsApp reminders** off for
your own business, reload, and:

- the **Reminders** link disappears from the sidebar
- and the route still refuses, which is the part that matters:

```bash
curl -H "Authorization: Bearer <your token>" http://localhost:8080/v1/reminders
# -> 403  "WhatsApp reminders is not enabled on your plan. Contact Munim to add it."
```

Hiding a link is presentation. Every route checks the same row, so a customer
editing their own client gains nothing.

**Test the ceiling too.** Set **Computers** to 1 while one is already connected,
then try to download another installer:

```
Your plan allows 1 computers. Contact Munim to raise it.
```

---

## 2b. Issue a licence key

**Admin → Licences → Issue keys** — 1 key, sold to your business name.

| Expect | Why |
|---|---|
| The key shows once, in a yellow box | Only the hash is stored; there is no second chance |
| The listing shows `MUNM-XXXX-****-****` | Staff can identify a key without being able to use it |
| Status `unused` | Nothing has redeemed it yet |

**Copy the key.**

---

## 3. Connect Tally

**Connect Tally** in the sidebar → **Download setup file**.

| Expect | |
|---|---|
| A `.bat` named for your business | e.g. `Munim-Setup-Arul-Enterprises.bat` |
| Not a `.ps1` | Windows runs `.bat` on a double-click; `.ps1` often opens Notepad |

**Double-click it.** Then:

1. It shows your business name and asks for a keypress
2. Four checks: Windows, internet, Munim server, Tally connection
3. It asks for your **licence key** — paste the one from step 2
4. `Licence accepted.` → `Connected to <your business>.`
5. It lists your books, syncs them, and installs itself to keep running

Meanwhile the **Connect Tally** page — without you refreshing — changes to:

> **One computer is connected**
> **YOUR-PC** · Tally is open · last heard from 4 seconds ago

---

## 4. The licence rule — the one worth testing

Run the same `.bat` again, or on another machine, and enter the **same key**:

```
This licence key is already being used by YOUR-PC.
Each key connects one computer. Contact Munim for another.
```

That is the whole protection: a customer cannot pass their key, or the setup
file, to anybody else.

Also try a made-up key — `MUNM-AAAA-BBBB-CCCC`:

```
That licence key is not valid. Check it against your invoice.
```

---

## 5. Your books

Refresh the dashboard. Everything is your own Tally data:

- sales, receivables, payables, cash
- growth against the previous 30 days
- top items, top debtors, recent vouchers

Check the reports: **Outstanding**, **Parties**, **Reports** (Day Book, Trial
Balance, P&L, Balance Sheet, Expenses, Sales, Purchases, Cash & Bank, Stock).

**Trial Balance must balance.** If it does not, that is a real bug — say so.

---

## 6. Live sync

With the connector running, add a voucher in Tally and save it.

Within a few seconds it appears on the dashboard and on your phone. No refresh.
The connector polls `ALTERID` every 3 seconds; a poll with nothing changed
returns nothing, so this is cheap.

---

## 7. The phone

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\expose-api.ps1   # as Administrator
npm run app:dev
```

Open Munim on the phone → **Continue with Google** → same account.

| Expect | Why |
|---|---|
| The same books, immediately | Same account, no second pairing |
| The web stays signed in | One session per *kind* of device: counter PC and pocket coexist |

**Now sign in on a second phone.** The first is signed out — one live mobile
session per account, so a sold or lost handset stops being a way in.

Close the app fully, turn Wi-Fi off, reopen it: **still signed in**, showing the
last figures it had. Only a rejected token signs you out.

---

## 8. Cutting things off

**Devices** — every signed-in phone and every connected computer.

| Action | Expect |
|---|---|
| Sign out all other devices | Others stop at once; this one keeps working |
| Unlink a computer | It stops syncing immediately, server-side |
| Admin → Licences → Cancel | The key dies **and** the computer using it stops |

---

## 9. Tenant isolation

Sign in with a second Google account, name a different business, and try to read
the first one's data:

```bash
curl -H "Authorization: Bearer <second account's token>" \
     http://localhost:8080/v1/companies/<first company guid>/dashboard
# -> 404  "No such company in your account."
```

A 404, not a 403: the second account should not learn that the company exists.

---

## Automated checks

```powershell
npm run api:test     # 57 tests
```

Covers Google token verification against forged tokens, account linking, session
rules, pairing codes, licence keys — including three machines racing one licence,
where exactly one must win — and the feature rules, including that a junk value
in the database cannot enable a paid feature.

---

## If something fails

| Symptom | Look at |
|---|---|
| `auth:check` fails | It names the fix |
| Setup file will not download | The API must be running, and the business named |
| `Tally connection FAIL` | Tally closed, or `Enable ODBC` not Yes |
| Phone cannot reach the API | Re-run `scripts\expose-api.ps1` as admin |
| Phone worked yesterday, not today | WSL took a new IP — re-run the same script |
| Nothing syncs after a restart | `.\connector-ps\Munim-Connector.ps1 status` |

---

## Ten customers on one Oracle VM

The plan is one small server and about ten customers. Two things make that work,
and both are worth understanding before you sell the first licence.

**One build, not ten.** Customers differ in what they have paid for, so features
are *data on the org* rather than a branch or a deployment per customer. There
is one API, one web app, one connector — and `Admin → Businesses` decides what
each account sees. A customer asking for reminders is a checkbox, not a release.

**One database, fenced per tenant.** Every report resolves the company through
the caller's org, so a bug that forgets the fence returns nothing rather than
somebody else's books. Step 9 is the test for that, and it is worth repeating
after any change to the report queries.

### What to set for a real customer

| | Typical | Why |
|---|---|---|
| Features | Dashboard, Outstanding, Parties, Reports, Statements, Stock | Everything a shop owner opens daily |
| Reminders | off unless bought | Each message costs money |
| Multiple companies | off unless they have more than one shop | |
| Computers | 1 | One licence key, one machine |
| Plan | whatever you invoiced | Free text — it is a label, not logic |

### Before the first real customer

The setup file currently points at `http://localhost:8080`, which only works on
this machine. On the VM, set:

```
PUBLIC_API_URL=https://api.your-domain.com
```

That is the one value the installer bakes in, and everything else follows.

See [20-costs.md](20-costs.md) for the ₹0 Oracle Always Free path, and
[11-infrastructure.md](11-infrastructure.md) for where it goes after that.
