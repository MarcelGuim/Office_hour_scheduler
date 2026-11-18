// Sends one email. With Gmail configured, through the Gmail API over HTTPS (port 443):
// DigitalOcean blocks outbound SMTP, so the backend cannot use Gmail's SMTP server.
// Without it, the email is printed to the log so the app works locally without Gmail.
//
// Two HTTPS calls, both to Google:
//   1. exchange the long-lived refresh token for an access token (valid about an hour,
//      cached until shortly before it expires);
//   2. POST the whole message (MIME, base64url) to users/me/messages/send. Google
//      delivers it from the authorised account, as if sent from Gmail.
// nodemailer only builds the MIME message (streamTransport); it never connects anywhere.

import nodemailer from 'nodemailer';
import { getConfig } from '../config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const TIMEOUT_MS = 10_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000; // refresh a minute early

// Error text from Google, without echoing anything we sent (it holds credentials).
async function googleError(step, res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body.error_description || body.error?.message || body.error || '';
  } catch {
    // body was not JSON
  }
  return new Error(`Gmail ${step} failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
}

// `gmail` is { clientId, clientSecret, refreshToken, from }. `fetchImpl` is replaceable
// so tests never call Google.
export function createGmailSender(gmail, fetchImpl = fetch) {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  let accessToken = null;
  let expiresAt = 0;

  async function getAccessToken() {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: gmail.clientId,
        client_secret: gmail.clientSecret,
        refresh_token: gmail.refreshToken,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw await googleError('token refresh', res);
    const body = await res.json();
    accessToken = body.access_token;
    expiresAt = Date.now() + body.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS;
    return accessToken;
  }

  return async function send({ to, subject, body }) {
    // Without `from`, Gmail fills in the authorised account's address.
    const { message } = await composer.sendMail({ from: gmail.from || undefined, to, subject, text: body });
    const token = await getAccessToken();
    const res = await fetchImpl(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: message.toString('base64url') }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) accessToken = null; // revoked or expired early: refresh next time
    if (!res.ok) throw await googleError('send', res);
  };
}

let sender;

// Throws on failure; the outbox loop records the error and retries later.
export async function sendEmail({ to, subject, body }) {
  const { gmail } = getConfig();
  if (!gmail) {
    console.log(`[email not sent: Gmail not configured] to=${to} subject="${subject}"\n${body}`);
    return;
  }
  sender ??= createGmailSender(gmail);
  await sender({ to, subject, body });
}
