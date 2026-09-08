import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { ChevronRight, Search } from 'lucide-react-native';
import { post } from '../lib/api';
import { useApp } from '../lib/store';
import { ago } from '../lib/format';
import {
  Badge, Button, Card, Label, Loading, Muted, Screen, Title,
} from '../components/ui';
import { askPermission, isEnabled, setEnabled, isSupported } from '../lib/notify';
import { T } from '../theme';

export default function MoreScreen({ navigation }: any) {
  const { me, company, privacy, togglePrivacy, signOut, refresh, setCompany } = useApp();
  const [bookQuery, setBookQuery] = useState('');
  const [bookSort, setBookSort] = useState<'name' | 'activity' | 'size'>('name');

  /*
   * Searching GSTIN as well as name: an accountant holding several firms knows
   * the GSTIN more reliably than whatever the book happens to be called in
   * Tally.
   */
  const visibleBooks = useMemo(() => {
    const all = me?.companies ?? [];
    const needle = bookQuery.trim().toLowerCase();
    const hit = needle
      ? all.filter((c) => c.name.toLowerCase().includes(needle)
                       || (c.gstin ?? '').toLowerCase().includes(needle))
      : all;
    const by = {
      name: (a: typeof all[number], b: typeof all[number]) => a.name.localeCompare(b.name),
      activity: (a: typeof all[number], b: typeof all[number]) =>
        new Date(b.lastSyncAt ?? 0).getTime() - new Date(a.lastSyncAt ?? 0).getTime(),
      size: (a: typeof all[number], b: typeof all[number]) => b.vouchers - a.vouchers,
    }[bookSort];
    return [...hit].sort(by);
  }, [me?.companies, bookQuery, bookSort]);
  const [toggling, setToggling] = React.useState<string | null>(null);
  const [notifyOn, setNotifyOn] = useState(false);
  // False on an app built before notifications were added: the toggle is shown
  // but disabled, which explains itself better than hiding it would.
  const notifySupported = isSupported();

  useEffect(() => { void isEnabled().then(setNotifyOn); }, []);

  async function toggleNotify(next: boolean) {
    if (next) {
      // Ask the system only when somebody actually turns it on - a permission
      // prompt on first launch, before anyone knows what the app does, is how
      // you get told no for ever.
      const ok = await askPermission();
      setNotifyOn(ok);
      if (!ok) {
        Alert.alert('Alerts are blocked',
          'Turn notifications on for Munim in your phone settings, then try again.');
      }
      return;
    }
    await setEnabled(false);
    setNotifyOn(false);
  }

  if (!me) return <Loading />;

  // Turning a book off reaches the shop PC on its next heartbeat. The owner
  // never has to go back to that computer.
  async function toggleSync(tallyGuid: string, enabled: boolean) {
    setToggling(tallyGuid);
    try {
      await post('/v1/companies/sync', { tallyGuid, enabled });
      await refresh();
    } catch (e) {
      Alert.alert('Could not change this', (e as Error).message);
    } finally { setToggling(null); }
  }

  return (
    <Screen header={<Text style={s.headName}>Settings</Text>}>

      {/*
        * Notifications, and the honest version of what they do.
        *
        * They arrive while the app is open or recently used, because these are
        * local - no push server, nothing to pay for. Saying so here is better
        * than a customer wondering why nothing buzzed overnight.
        */}
      <Card style={{ marginTop: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Label>Alerts</Label>
            <Text style={s.settingHint}>
              {!notifySupported
                ? 'Update the app to be told when new entries reach your books.'
                : notifyOn
                  ? 'You will be told when new entries reach your books.'
                  : 'Turn on to be told when new entries reach your books.'}
            </Text>
          </View>
          <Switch
            value={notifyOn}
            onValueChange={toggleNotify}
            disabled={!notifySupported}
            trackColor={{ false: T.line, true: T.greenTint }}
            thumbColor={notifyOn ? T.green : '#fff'}
          />
        </View>
      </Card>

      {/*
        * Grouped by the question being asked, not by where the data came from.
        * "Who am I", "what am I paying for", "what is connected" - three
        * cards, so nobody scrolls a single undifferentiated list.
        */}
      <Card style={{ marginTop: 14 }}>
        <Label>You</Label>
        <Row k="Name" v={me.user.name || '—'} />
        <Row k="Email" v={me.user.email || '—'} />
        {me.user.phone ? <Row k="Mobile" v={me.user.phone} /> : null}
        <Text style={s.settingHint}>
          Signed in with Google. Your name and email come from that account.
        </Text>
      </Card>

      {/* Screens that do not need a tab of their own but must be reachable. */}
      <Card style={{ marginTop: 14 }}>
        <Label>Your books</Label>
        <Pressable onPress={() => navigation.navigate('Sync')} style={s.jump}>
          <Text style={s.jumpText}>Sync & connector</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Insights')} style={s.jump}>
          <Text style={s.jumpText}>Business insights</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('CashBank')} style={s.jump}>
          <Text style={s.jumpText}>Cash & Bank</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Search')} style={s.jump}>
          <Text style={s.jumpText}>Search</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Notifications')} style={s.jump}>
          <Text style={s.jumpText}>Notifications</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Reminders')} style={s.jump}>
          <Text style={s.jumpText}>Reminders</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Gst')} style={s.jump}>
          <Text style={s.jumpText}>GST</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Parties')} style={s.jump}>
          <Text style={s.jumpText}>Parties</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Entry')} style={s.jump}>
          <Text style={s.jumpText}>New entry</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Pulse')} style={s.jump}>
          <Text style={s.jumpText}>Pulse</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Kpi')} style={s.jump}>
          <Text style={s.jumpText}>Key numbers</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Items')} style={s.jump}>
          <Text style={s.jumpText}>Items & stock</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Users')} style={s.jump}>
          <Text style={s.jumpText}>Users & roles</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Help')} style={s.jump}>
          <Text style={s.jumpText}>Help</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Customise')} style={s.jump}>
          <Text style={s.jumpText}>Customise</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Security')} style={s.jump}>
          <Text style={s.jumpText}>Security & sign-in</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Devices')} style={s.jump}>
          <Text style={s.jumpText}>Linked devices</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Audit')} style={s.jump}>
          <Text style={s.jumpText}>Audit log</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Account')} style={s.jump}>
          <Text style={s.jumpText}>Account</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
        <Pressable onPress={() => navigation.navigate('Billing')} style={s.jump}>
          <Text style={s.jumpText}>Plan & billing</Text>
          <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        </Pressable>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <Label>Business</Label>
        <Row k="Name" v={me.org.name} />
        <Row k="Plan" v={me.org.plan} />
        <Row k="Message credits" v={String(me.org.messageCredits)} />
        <Row k="Computers" v={`${me.connectors} of ${me.limits?.connectors ?? 1}`} />
        <Row k="Books" v={`${me.companies.length} of ${me.limits?.companies ?? 1}`} />
      </Card>

      <Card style={{ marginTop: 14 }}>
        <Label>Books from Tally</Label>
        {/* Search and sort appear only once there are enough books to need
            them. On the single-company account that is most customers, they
            would be two controls that never do anything. */}
        {me.companies.length > 3 && (
          <>
            <View style={s.searchRow}>
              <Search size={15} color={T.muted} />
              <TextInput
                value={bookQuery}
                onChangeText={setBookQuery}
                placeholder="Search name or GSTIN"
                placeholderTextColor={T.faint}
                style={s.searchInput}
                autoCorrect={false}
                autoCapitalize="none" />
            </View>
            <View style={{ flexDirection: 'row', gap: 7, marginBottom: 4 }}>
              {([['name', 'Name'], ['activity', 'Recent'], ['size', 'Biggest']] as const)
                .map(([key, label]) => (
                  <Pressable key={key} onPress={() => setBookSort(key)}
                    style={[s.sortChip, bookSort === key && s.sortChipOn]}>
                    <Text style={[s.sortText, bookSort === key && s.sortTextOn]}>{label}</Text>
                  </Pressable>
                ))}
            </View>
          </>
        )}
        {me.companies.length === 0 ? (
          <Muted>No books yet. Link the computer that runs Tally.</Muted>
        ) : visibleBooks.map((c) => {
          const open = company?.tallyGuid === c.tallyGuid;
          return (
            /*
             * Tapping the row switches book.
             *
             * setCompany existed but nothing called it, so an owner with two
             * companies in Tally was permanently stuck on whichever sorted
             * first - every figure in the app was the wrong company's, with
             * nothing on screen saying so.
             */
            <Pressable key={c.tallyGuid} onPress={() => { setCompany(c.tallyGuid); refresh(); }}
              style={[s.book, open && s.bookOpen]}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <Text style={s.bookName}>{c.name}</Text>
                  {open ? <Badge tone="ok">Open</Badge> : null}
                </View>
                <Text style={s.bookSub}>
                  {c.vouchers.toLocaleString('en-IN')} vouchers · synced {ago(c.lastSyncAt)}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 6 }}>
                <Badge tone={c.enabled ? 'ok' : 'muted'}>{c.enabled ? 'Syncing' : 'Paused'}</Badge>
                <Button
                  title={toggling === c.tallyGuid ? '…' : c.enabled ? 'Pause' : 'Resume'}
                  variant="ghost"
                  onPress={() => toggleSync(c.tallyGuid, !c.enabled)} />
              </View>
            </Pressable>
          );
        })}
        {visibleBooks.length === 0 && bookQuery.trim() ? (
          <Muted>No book matches “{bookQuery.trim()}”.</Muted>
        ) : null}
        {me.companies.length > 1 && (
          <Muted>Tap a book to switch to it.</Muted>
        )}
      </Card>

      <Card style={{ marginTop: 14 }}>
        <Label>Tally connection</Label>
        <Row k="Computers linked" v={String(me.connectors)} />
        <Row k="Companies" v={String(me.companies.length)} />
        {company ? <Row k="Last sync" v={ago(company.lastSyncAt)} /> : null}
        <View style={{ marginTop: 12, gap: 8 }}>
          <Button title="Link another Tally computer"
            onPress={() => navigation.navigate('LinkTally')} />
          <Button title="Manage linked devices" variant="ghost"
            onPress={() => navigation.navigate('Devices')} />
          <Button title="Refresh now" variant="ghost" onPress={() => void refresh()} />
        </View>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <Label>Privacy</Label>
        <Muted>Hide every amount with one tap. Useful when others can see your screen.</Muted>
        <View style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Badge tone={privacy ? 'warn' : 'muted'}>{privacy ? 'Amounts hidden' : 'Amounts visible'}</Badge>
          <View style={{ flex: 1 }}>
            <Button title={privacy ? 'Show amounts' : 'Hide amounts'}
              variant="ghost" onPress={togglePrivacy} />
          </View>
        </View>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <Text style={s.note}>
          Munim reads your Tally data. The only thing it writes is a voucher you
          create here and send. Nothing already in your books is ever changed.
        </Text>
      </Card>

      <View style={{ marginTop: 20, marginBottom: 32 }}>
        <Button title="Sign out" variant="ghost" onPress={() =>
          Alert.alert('Sign out?', 'You will need to sign in with Google again.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
          ])} />
      </View>
    </Screen>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.row}>
      <Text style={s.k}>{k}</Text>
      <Text style={s.v}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  jump: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
          borderTopWidth: 1, borderTopColor: T.lineSoft },
  jumpText: { flex: 1, fontSize: 14.5, color: T.ink, fontFamily: T.font.medium },
  settingHint: { fontSize: 12.5, color: T.muted, marginTop: 3,
                 fontFamily: T.font.regular, lineHeight: 18 },
  headName: { fontSize: 19, fontFamily: T.font.bold, color: T.ink, letterSpacing: -0.3 },
  headSub: { fontSize: 12.5, color: T.muted, marginTop: 2, fontFamily: T.font.regular },
  wrap: { padding: 16, backgroundColor: T.bg, flexGrow: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between',
         alignItems: 'center', paddingVertical: 7, gap: 12 },
  book: { flexDirection: 'row', alignItems: 'center', gap: 12,
          paddingVertical: 10, borderTopWidth: 1, borderTopColor: T.line },
  // The open book is tinted rather than outlined: a border inside a card that
  // already has one reads as a rendering fault.
  bookOpen: { backgroundColor: T.greenSoft, borderRadius: T.radiusSm,
              paddingHorizontal: 10, marginHorizontal: -10 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingHorizontal: 12, marginTop: 8, marginBottom: 8,
  },
  searchInput: {
    flex: 1, paddingVertical: 10, fontFamily: T.font.regular,
    fontSize: 14, color: T.ink,
  },
  sortChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    backgroundColor: T.lineSoft,
  },
  sortChipOn: { backgroundColor: T.green },
  sortText: { fontFamily: T.font.semibold, fontSize: 12, color: T.inkSoft },
  sortTextOn: { color: T.card },
  bookName: { fontFamily: T.font.bold, color: T.ink },
  bookSub: { color: T.muted, fontSize: 11, marginTop: 2 },
  k: { color: T.muted, fontSize: 13 },
  v: { color: T.ink, fontFamily: T.font.bold, fontSize: 13 },
  note: { color: T.muted, fontSize: 12, lineHeight: 18 },
});
