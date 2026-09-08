'use client';

import { post } from './api';

/**
 * Getting a document out of Munim and to somebody else.
 *
 * All of it client-side. A server-rendered PDF would mean a headless browser,
 * a font bundle and a queue - real money and real operational weight - for
 * something the browser already does natively through its own print dialogue,
 * with the customer's own paper size and margins.
 *
 * WhatsApp and email are handed off to the device rather than sent by us.
 * Sending on the customer's behalf needs a WhatsApp Business account billed per
 * conversation, or a mail domain with its own deliverability problems. Handing
 * off costs nothing, works today, and sends from the shop's own number - which
 * is what a customer recognises.
 */

/** Plain text of a document, for WhatsApp and email bodies. */
export function documentText(opts: {
  company: string;
  title: string;
  lines: string[];
  footer?: string;
}): string {
  return [
    `*${opts.company}*`,
    opts.title,
    '',
    ...opts.lines,
    ...(opts.footer ? ['', opts.footer] : []),
  ].join('\n');
}

/**
 * Open WhatsApp with the message ready to send.
 *
 * wa.me works on the phone app and on WhatsApp Web, so one link serves both.
 * The number is optional: without it WhatsApp asks who to send to, which is
 * what you want when a party has no number on file.
 */
export function shareOnWhatsApp(text: string, phone?: string) {
  const num = (phone || '').replace(/\D/g, '');
  // A 10-digit Indian number needs its country code, or WhatsApp will not
  // find it. Longer numbers are assumed to carry one already.
  const to = num.length === 10 ? `91${num}` : num;
  const url = to
    ? `https://wa.me/${to}?text=${encodeURIComponent(text)}`
    : `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
}

/** Open the mail client with subject and body filled in. */
export function shareByEmail(subject: string, body: string, to?: string) {
  const url = `mailto:${encodeURIComponent(to || '')}`
    + `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = url;
}

/**
 * The system share sheet, where the browser has one.
 *
 * Chrome on Android and Safari on iOS support it; a desktop browser usually
 * does not. Returns false so the caller can fall back rather than leaving a
 * button that silently does nothing.
 */
export async function shareNative(title: string, text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.share) return false;
  try {
    await navigator.share({ title, text });
    return true;
  } catch {
    // A cancelled share throws. Not an error, and not worth reporting.
    return false;
  }
}

/** Copy to the clipboard, with a fallback for browsers that refuse. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Print, or save as PDF.
 *
 * One button for both, because "Save as PDF" lives inside the browser's own
 * print dialogue - and every browser has it. A separate PDF path would mean
 * shipping a renderer to do worse.
 *
 * The printed area is controlled by CSS in globals.css: `.no-print` is hidden
 * and `.print-area` fills the page.
 */
export function printDocument(name?: string) {
  // Print and Save-as-PDF are the same browser action, so this covers both.
  post('/v1/audit/event', {
    action: 'doc.download', name: name ?? 'document', format: 'pdf',
  }).catch(() => {});
  window.print();
}
