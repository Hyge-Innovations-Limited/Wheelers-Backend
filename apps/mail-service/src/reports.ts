/**
 * Reading the machine reports mail servers send back:
 *  - a bounce (DSN, RFC 3464): multipart/report; report-type=delivery-status,
 *    with a message/delivery-status part saying, per recipient, failed or
 *    delayed, a status (5.1.1) and the server's words;
 *  - a complaint (ARF, RFC 5965): multipart/report; report-type=feedback-report,
 *    sent by Yahoo and Microsoft when someone presses "spam".
 * Both usually carry the original message (or its headers), whose Message-ID
 * says which of our emails it was.
 */

/** "Name: value" fields, folded lines joined, in blocks split by blank lines. */
export function fieldBlocks(text: string): Array<Record<string, string>> {
  const blocks: Array<Record<string, string>> = [];
  let current: Record<string, string> = {};
  let last: string | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') {
      if (Object.keys(current).length) blocks.push(current);
      current = {};
      last = null;
      continue;
    }
    if (/^[ \t]/.test(line) && last) {
      current[last] += ` ${line.trim()}`;
      continue;
    }
    const at = line.indexOf(':');
    if (at < 1) continue;
    last = line.slice(0, at).trim().toLowerCase();
    current[last] = line.slice(at + 1).trim();
  }
  if (Object.keys(current).length) blocks.push(current);
  return blocks;
}

/** "rfc822; ada@x.com" → "ada@x.com". */
const typedAddress = (value: string | undefined) => (value ? value.replace(/^[^;]*;\s*/, '').replace(/[<>]/g, '').trim().toLowerCase() || null : null);

export type BounceReport = {
  recipient: string | null;
  action: 'failed' | 'delayed' | 'delivered' | 'relayed' | 'expanded' | 'unknown';
  status: string | null;
  diagnostic: string | null;
};

/** Each recipient's line in a delivery-status part. The first block is about the report itself, not a recipient. */
export function parseDeliveryStatus(text: string): BounceReport[] {
  return fieldBlocks(text)
    .filter((b) => b['final-recipient'] || b['original-recipient'] || b['action'])
    .map((b) => {
      const action = (b['action'] ?? '').toLowerCase();
      return {
        recipient: typedAddress(b['final-recipient'] ?? b['original-recipient']),
        action: (['failed', 'delayed', 'delivered', 'relayed', 'expanded'].includes(action) ? action : 'unknown') as BounceReport['action'],
        status: /\b[245]\.\d{1,3}\.\d{1,3}\b/.exec(b['status'] ?? '')?.[0] ?? null,
        diagnostic: (b['diagnostic-code'] ?? '').replace(/^[^;]*;\s*/, '').slice(0, 500) || null,
      };
    });
}

export type ComplaintReport = { feedbackType: string; recipient: string | null; sourceIp: string | null };

export function parseFeedbackReport(text: string): ComplaintReport | null {
  const fields = Object.assign({}, ...fieldBlocks(text)) as Record<string, string>;
  if (!fields['feedback-type']) return null;
  return {
    feedbackType: fields['feedback-type'].toLowerCase(),
    recipient: typedAddress(fields['original-rcpt-to'] ?? fields['removal-recipient']),
    sourceIp: fields['source-ip'] ?? null,
  };
}

/** The Message-ID in an original message or its headers (the part a report carries). */
export function originalMessageId(text: string): string | null {
  const head = text.replace(/\r\n/g, '\n').split('\n\n')[0] ?? '';
  const m = /^message-id:\s*(<[^<>\s]+>)/im.exec(head.replace(/\n[ \t]+/g, ' '));
  return m ? m[1]! : null;
}

/** The To address in an original message's headers. */
export function originalTo(text: string): string | null {
  const head = text.replace(/\r\n/g, '\n').split('\n\n')[0] ?? '';
  const m = /^to:\s*(.+)$/im.exec(head.replace(/\n[ \t]+/g, ' '));
  const address = m ? /<([^<>\s]+@[^<>\s]+)>|([^\s<>,"]+@[^\s<>,"]+)/.exec(m[1]!) : null;
  return address ? (address[1] ?? address[2] ?? '').toLowerCase() : null;
}
