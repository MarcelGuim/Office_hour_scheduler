// Sends one email. With SMTP configured (Gmail + app password), through nodemailer;
// without it, the email is printed to the log so the app works locally without Gmail.

import nodemailer from 'nodemailer';
import { getConfig } from '../config.js';

let transport;

function getTransport() {
  const { smtp } = getConfig();
  if (!smtp) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465, // 465 = TLS from the start; 587 = STARTTLS
      auth: { user: smtp.user, pass: smtp.password },
    });
  }
  return transport;
}

export async function sendEmail({ to, subject, body }) {
  const t = getTransport();
  if (!t) {
    console.log(`[email not sent: no SMTP configured] to=${to} subject="${subject}"\n${body}`);
    return;
  }
  await t.sendMail({ from: getConfig().smtp.from, to, subject, text: body });
}
