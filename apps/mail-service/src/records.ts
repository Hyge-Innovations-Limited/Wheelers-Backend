import type { MailConfig } from './config';
import { dkimDnsValue } from './dkim';

export type DnsRecord = { type: 'A' | 'PTR' | 'MX' | 'TXT'; name: string; value: string; why: string };

/**
 * The DNS records the service needs, filled in from its settings. PTR is set
 * at the server's host (its control panel), not in the domain's DNS. The
 * domain's own SPF record (Zoho's, for the people's inboxes) is left alone:
 * our mail's envelope is on the bounce domain, which has its own.
 */
export function dnsRecords(config: MailConfig): DnsRecord[] {
  const ip = config.publicIp ?? '<the server IPv4>';
  const records: DnsRecord[] = [
    { type: 'A', name: config.hostname, value: ip, why: 'The mail server\'s name points to its address.' },
    { type: 'PTR', name: ip, value: config.hostname, why: 'Reverse DNS, set at the server host: the address points back to the name. Gmail refuses mail without it.' },
    { type: 'TXT', name: config.hostname, value: `v=spf1 ip4:${ip} -all`, why: 'SPF for the name the server says hello with.' },
    { type: 'TXT', name: config.bounceDomain, value: `v=spf1 ip4:${ip} -all`, why: 'SPF for the envelope sender (bounce domain): only this server sends as it.' },
    {
      type: 'TXT',
      name: `${config.dkim.selector}._domainkey.${config.domain}`,
      value: config.dkim.privateKey ? dkimDnsValue(config.dkim.privateKey) : '<make the key first: cli dkim-keygen>',
      why: 'DKIM: the public key that proves our signature. A new selector each quarter; the old one stays a week after switching.',
    },
    {
      type: 'TXT',
      name: `_dmarc.${config.domain}`,
      value: `v=DMARC1; p=none; rua=mailto:${config.dmarcMailbox}; adkim=r; aspf=r`,
      why: 'DMARC: start with p=none and read the reports; quarantine after about 4 clean weeks, then reject.',
    },
  ];
  for (const domain of config.inboundDomains) {
    records.push({ type: 'MX', name: domain, value: `10 ${config.hostname}`, why: `Mail to @${domain} comes to this server.` });
  }
  return records;
}
