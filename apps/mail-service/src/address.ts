import { domainToASCII } from 'node:url';
import addressparser from 'nodemailer/lib/addressparser';

/** An email address and the name shown with it: "Ada <ada@example.com>". */
export type Mailbox = { address: string; name: string | null };

const LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * One address, checked: plain local part, a real-looking domain (an
 * international one turned to its xn-- form), at most 254 characters, no line
 * breaks. Lower case: mail providers treat addresses as case-blind, and so do
 * we for suppression and for counting. Null when it is not an address.
 */
export function normaliseAddress(value: string): string | null {
  const text = value.trim();
  if (!text || /[\r\n\s<>]/.test(text) || text.length > 254) return null;
  const at = text.lastIndexOf('@');
  if (at < 1) return null;
  const local = text.slice(0, at);
  const domain = domainToASCII(text.slice(at + 1).toLowerCase());
  if (!LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (!domain || !DOMAIN.test(domain)) return null;
  return `${local.toLowerCase()}@${domain}`;
}

export const domainOfAddress = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/** "Ada <ada@x.com>", "ada@x.com" or a list of them: each address checked. Throws on any that is not one. */
export function parseMailboxes(value: unknown, field: string): Mailbox[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  const out: Mailbox[] = [];
  for (const item of items) {
    if (typeof item !== 'string') throw new AddressError(`${field}: each address must be text`);
    if (/[\r\n]/.test(item)) throw new AddressError(`${field}: an address cannot have a line break`);
    const parsed = addressparser(item, { flatten: true }) as Array<{ address?: string; name?: string }>;
    if (parsed.length === 0) throw new AddressError(`${field}: "${item}" is not an email address`);
    for (const p of parsed) {
      const address = normaliseAddress(p.address ?? '');
      if (!address) throw new AddressError(`${field}: "${p.address ?? item}" is not an email address`);
      out.push({ address, name: p.name?.trim() || null });
    }
  }
  return out;
}

export class AddressError extends Error {}

/** Header text for one mailbox: the name quoted when it must be. */
export function formatMailbox(m: Mailbox): string {
  if (!m.name) return m.address;
  const name = /^[\w .'-]+$/.test(m.name) ? m.name : `"${m.name.replace(/["\\]/g, '\\$&')}"`;
  return `${name} <${m.address}>`;
}
