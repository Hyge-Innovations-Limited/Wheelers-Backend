// ── Shared layout shell ─────────────────────────────────────────────

function emailShell(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Wheelers</title>
</head>
<body style="margin:0;padding:0;background-color:#FFFAF5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FFFAF5;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" style="max-width:520px;background-color:#FFFFFF;border:2.5px solid #0D0D0D;border-radius:10px;overflow:hidden;">

<!-- Header -->
<tr>
<td style="background-color:#FF5C00;padding:32px 36px;text-align:center;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center">
    <div style="width:52px;height:52px;border-radius:50%;background-color:rgba(255,255,255,0.2);display:inline-block;line-height:52px;text-align:center;">
      <span style="font-size:22px;font-weight:800;color:#FFFFFF;letter-spacing:-0.5px;">W</span>
    </div>
  </td></tr>
  <tr><td align="center" style="padding-top:12px;">
    <span style="font-size:18px;font-weight:800;color:#FFFFFF;letter-spacing:-0.3px;">WHEELERS</span>
  </td></tr>
  </table>
</td>
</tr>

<!-- Body -->
<tr>
<td style="padding:36px 36px 28px;">
${content}
</td>
</tr>

<!-- Footer -->
<tr>
<td style="padding:0 36px 32px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="border-top:1.5px solid #E8DDD3;padding-top:20px;">
    <p style="margin:0;font-size:11px;color:#786F68;line-height:18px;text-align:center;">
      Need help? Reach us at <a href="mailto:support@wheelersng.com" style="color:#FF5C00;text-decoration:none;font-weight:600;">support@wheelersng.com</a>
    </p>
    <p style="margin:8px 0 0;font-size:10px;color:#B5ACA4;line-height:15px;text-align:center;">
      Wheelers &middot; ride. earn. own.
    </p>
  </td></tr>
  </table>
</td>
</tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Welcome email for new drivers ───────────────────────────────────

export function buildWelcomeDriverEmail(driverName?: string): { subject: string; html: string; from: string } {
  const greeting = driverName ? `Hi ${driverName},` : 'Hi there,';

  const html = emailShell(`
  <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#0D0D0D;line-height:28px;letter-spacing:-0.3px;">
    Welcome to Wheelers!
  </h1>
  <p style="margin:0 0 16px;font-size:14px;color:#0D0D0D;line-height:22px;">
    ${greeting}
  </p>
  <p style="margin:0 0 16px;font-size:14px;color:#0D0D0D;line-height:22px;">
    You're now part of the Wheelers driver community. We're building something different &mdash; a ride-hailing platform where drivers actually own a piece of the network.
  </p>
  <p style="margin:0 0 16px;font-size:14px;color:#0D0D0D;line-height:22px;">
    Here's what to do next:
  </p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
    <tr>
      <td style="padding:0 12px 12px 0;vertical-align:top;">
        <div style="width:28px;height:28px;border-radius:50%;background-color:#FFF0E8;border:2px solid #FF5C00;text-align:center;line-height:28px;font-size:12px;font-weight:700;color:#FF5C00;">1</div>
      </td>
      <td style="padding:0 0 12px;font-size:14px;color:#0D0D0D;line-height:20px;">
        <strong>Complete your profile</strong> &mdash; upload your documents so we can verify your account.
      </td>
    </tr>
    <tr>
      <td style="padding:0 12px 12px 0;vertical-align:top;">
        <div style="width:28px;height:28px;border-radius:50%;background-color:#FFF0E8;border:2px solid #FF5C00;text-align:center;line-height:28px;font-size:12px;font-weight:700;color:#FF5C00;">2</div>
      </td>
      <td style="padding:0 0 12px;font-size:14px;color:#0D0D0D;line-height:20px;">
        <strong>Get approved</strong> &mdash; we'll review your documents and get you on the road.
      </td>
    </tr>
    <tr>
      <td style="padding:0 12px 0 0;vertical-align:top;">
        <div style="width:28px;height:28px;border-radius:50%;background-color:#FFF0E8;border:2px solid #FF5C00;text-align:center;line-height:28px;font-size:12px;font-weight:700;color:#FF5C00;">3</div>
      </td>
      <td style="padding:0;font-size:14px;color:#0D0D0D;line-height:20px;">
        <strong>Start earning</strong> &mdash; accept rides, set your own schedule, and build your reputation.
      </td>
    </tr>
  </table>
  <p style="margin:0;font-size:14px;color:#0D0D0D;line-height:22px;">
    We're glad to have you on board. Let's ride.
  </p>
  <p style="margin:16px 0 0;font-size:14px;color:#786F68;line-height:22px;">
    &mdash; The Wheelers Team
  </p>`);

  return {
    subject: 'Welcome to Wheelers — let\'s get you on the road',
    html,
    from: 'Wheelers <hello@wheelersng.com>',
  };
}

// ── Driver KYC approved ─────────────────────────────────────────────

export function buildDriverApprovedEmail(driverName?: string): { subject: string; html: string; from: string } {
  const greeting = driverName ? `Hi ${driverName},` : 'Hi there,';

  const html = emailShell(`
  <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#0D0D0D;line-height:28px;letter-spacing:-0.3px;">
    You're approved &mdash; welcome aboard!
  </h1>
  <p style="margin:0 0 16px;font-size:14px;color:#0D0D0D;line-height:22px;">
    ${greeting}
  </p>
  <p style="margin:0 0 20px;font-size:14px;color:#0D0D0D;line-height:22px;">
    Your documents have been reviewed and your driver account is now <strong>approved</strong>. You can go online and start accepting rides right away.
  </p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
    <tr><td align="center">
      <div style="display:inline-block;background-color:#FFF0E8;border:2.5px solid #0D0D0D;border-radius:10px;padding:14px 32px;font-size:15px;font-weight:800;color:#FF5C00;letter-spacing:0.5px;">
        ACCOUNT APPROVED
      </div>
    </td></tr>
  </table>
  <p style="margin:0 0 16px;font-size:14px;color:#0D0D0D;line-height:22px;">
    To start earning:
  </p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
    <tr>
      <td style="padding:0 12px 12px 0;vertical-align:top;">
        <div style="width:28px;height:28px;border-radius:50%;background-color:#FFF0E8;border:2px solid #FF5C00;text-align:center;line-height:28px;font-size:12px;font-weight:700;color:#FF5C00;">1</div>
      </td>
      <td style="padding:0 0 12px;font-size:14px;color:#0D0D0D;line-height:20px;">
        <strong>Open the Wheelers driver app</strong> &mdash; your account is ready to go.
      </td>
    </tr>
    <tr>
      <td style="padding:0 12px 12px 0;vertical-align:top;">
        <div style="width:28px;height:28px;border-radius:50%;background-color:#FFF0E8;border:2px solid #FF5C00;text-align:center;line-height:28px;font-size:12px;font-weight:700;color:#FF5C00;">2</div>
      </td>
      <td style="padding:0 0 12px;font-size:14px;color:#0D0D0D;line-height:20px;">
        <strong>Go online</strong> &mdash; you'll start seeing ride requests from riders near you.
      </td>
    </tr>
    <tr>
      <td style="padding:0 12px 0 0;vertical-align:top;">
        <div style="width:28px;height:28px;border-radius:50%;background-color:#FFF0E8;border:2px solid #FF5C00;text-align:center;line-height:28px;font-size:12px;font-weight:700;color:#FF5C00;">3</div>
      </td>
      <td style="padding:0;font-size:14px;color:#0D0D0D;line-height:20px;">
        <strong>Bid and earn</strong> &mdash; your earnings land in your Wheelers wallet after each ride.
      </td>
    </tr>
  </table>
  <p style="margin:0;font-size:14px;color:#0D0D0D;line-height:22px;">
    Drive safe out there.
  </p>
  <p style="margin:16px 0 0;font-size:14px;color:#786F68;line-height:22px;">
    &mdash; The Wheelers Team
  </p>`);

  return {
    subject: 'You\'re approved — start driving with Wheelers',
    html,
    from: 'Wheelers <hello@wheelersng.com>',
  };
}

// ── Driver verification needs a fix ──────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Sent when an admin sends items back: what to fix, in the admin's words. */
export function buildDriverRejectedEmail(
  driverName: string | undefined,
  items: { label: string; reason?: string }[],
): { subject: string; html: string; from: string } {
  const greeting = driverName ? `Hi ${escapeHtml(driverName)},` : 'Hi there,';
  const rows = items.map((item) => `
    <tr><td style="padding:0 0 12px;font-size:14px;color:#0D0D0D;line-height:20px;">
      <strong>${escapeHtml(item.label)}</strong>${item.reason ? ` &mdash; ${escapeHtml(item.reason)}` : ''}
    </td></tr>`).join('');

  const html = emailShell(`
  <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#0D0D0D;line-height:28px;letter-spacing:-0.3px;">
    ${items.length === 1 ? 'One thing to fix' : 'A few things to fix'}
  </h1>
  <p style="margin:0 0 16px;font-size:14px;color:#0D0D0D;line-height:22px;">
    ${greeting}
  </p>
  <p style="margin:0 0 20px;font-size:14px;color:#0D0D0D;line-height:22px;">
    We checked your documents and need you to send ${items.length === 1 ? 'this' : 'these'} again. Everything else is kept, so you only redo what's listed.
  </p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">${rows}
  </table>
  <p style="margin:0;font-size:14px;color:#0D0D0D;line-height:22px;">
    Open the Wheelers driver app to fix it. We'll look again as soon as you send it.
  </p>
  <p style="margin:16px 0 0;font-size:14px;color:#786F68;line-height:22px;">
    &mdash; The Wheelers Team
  </p>`);

  return {
    subject: 'Your Wheelers verification needs a fix',
    html,
    from: 'Wheelers <hello@wheelersng.com>',
  };
}

// ── Password reset code email ───────────────────────────────────────

export function buildPasswordResetEmail(code: string): { subject: string; html: string; from: string } {
  const html = emailShell(`
  <h1 style="margin:0 0 16px;font-size:22px;font-weight:800;color:#0D0D0D;line-height:28px;letter-spacing:-0.3px;">
    Reset your password
  </h1>
  <p style="margin:0 0 20px;font-size:14px;color:#0D0D0D;line-height:22px;">
    You requested a password reset. Use this code in the Wheelers app to set a new password:
  </p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
    <tr><td align="center">
      <div style="display:inline-block;background-color:#FFF0E8;border:2.5px solid #0D0D0D;border-radius:10px;padding:16px 36px;letter-spacing:8px;font-size:32px;font-weight:800;color:#FF5C00;">
        ${code}
      </div>
    </td></tr>
  </table>
  <p style="margin:0 0 8px;font-size:14px;color:#0D0D0D;line-height:22px;">
    This code expires in <strong>10 minutes</strong>.
  </p>
  <p style="margin:0;font-size:13px;color:#786F68;line-height:20px;">
    If you didn't request this, you can safely ignore this email. Your password won't change.
  </p>`);

  return {
    subject: 'Your Wheelers password reset code',
    html,
    from: 'Wheelers <noreply@wheelersng.com>',
  };
}
