// Auth controller: reads the body and the refresh-token cookie, calls the service,
// sets the cookie and sends the response.

import { getConfig } from '../../config.js';
import * as service from './auth.services.js';

const COOKIE_NAME = 'refresh_token';

function cookieOptions() {
  const config = getConfig();
  return {
    httpOnly: true, // JavaScript in the page cannot read it, so an XSS bug cannot steal it
    secure: config.cookieSecure, // HTTPS-only; false until the deployment has HTTPS
    sameSite: 'strict', // not sent on requests started by other sites
    path: '/auth', // only sent to /auth/*, not to every API call
    maxAge: config.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  };
}

function sendSession(res, session) {
  const { refreshToken, ...body } = session;
  res.cookie(COOKIE_NAME, refreshToken, cookieOptions());
  return res.status(200).json(body);
}

export async function register(req, res) {
  const { name, email, password } = req.body;
  const user = await service.register({ name, email, password });
  return res.status(201).json(user);
}

export async function login(req, res) {
  const { email, password } = req.body;
  return sendSession(res, await service.login({ email, password }));
}

export async function refresh(req, res) {
  return sendSession(res, await service.refresh(req.cookies[COOKIE_NAME]));
}

export async function logout(req, res) {
  await service.logout(req.cookies[COOKIE_NAME]);
  const { maxAge, ...options } = cookieOptions(); // clearCookie ignores maxAge
  res.clearCookie(COOKIE_NAME, options);
  return res.status(204).end();
}
