import { Linking, Share } from 'react-native';

/**
 * Getting a document out of Munim and to somebody else.
 *
 * The phone already has a share sheet, WhatsApp and a mail client, and every
 * one of them sends from the shop's own number or address - which is what a
 * customer recognises. Sending on their behalf would need a WhatsApp Business
 * account billed per conversation and a mail domain of our own, for a worse
 * result.
 */

export function documentText(opts: {
  company: string; title: string; lines: string[]; footer?: string;
}): string {
  return [
    `*${opts.company}*`,
    opts.title,
    '',
    ...opts.lines,
    ...(opts.footer ? ['', opts.footer] : []),
  ].join('\n');
}

/** The system share sheet: WhatsApp, mail, Drive, whatever they have. */
export async function shareText(title: string, message: string): Promise<boolean> {
  try {
    const r = await Share.share({ title, message });
    return r.action === Share.sharedAction;
  } catch {
    // A cancelled share throws on some Android skins. Not an error.
    return false;
  }
}

/**
 * Straight into WhatsApp, with the message ready.
 *
 * Tries the app's own scheme first and falls back to the web link, because
 * `whatsapp://` fails silently when the app is not installed while wa.me
 * opens the browser and offers to install it.
 */
export async function shareOnWhatsApp(text: string, phone?: string): Promise<boolean> {
  const num = (phone || '').replace(/\D/g, '');
  // A bare 10-digit Indian number needs its country code or WhatsApp cannot
  // resolve it.
  const to = num.length === 10 ? `91${num}` : num;

  const appUrl = to
    ? `whatsapp://send?phone=${to}&text=${encodeURIComponent(text)}`
    : `whatsapp://send?text=${encodeURIComponent(text)}`;
  const webUrl = to
    ? `https://wa.me/${to}?text=${encodeURIComponent(text)}`
    : `https://wa.me/?text=${encodeURIComponent(text)}`;

  try {
    if (await Linking.canOpenURL(appUrl)) {
      await Linking.openURL(appUrl);
      return true;
    }
  } catch { /* fall through to the web link */ }

  try {
    await Linking.openURL(webUrl);
    return true;
  } catch {
    return false;
  }
}

/** Hand off to the mail client. */
export async function shareByEmail(subject: string, body: string, to?: string): Promise<boolean> {
  const url = `mailto:${encodeURIComponent(to || '')}`
    + `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
