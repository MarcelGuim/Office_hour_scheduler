// API client shared by every page.
// The access token lives only in this variable (memory), never in localStorage, so a
// script injected into the page cannot find it in storage. Every page load gets a
// fresh one from POST /auth/refresh, which uses the httpOnly refresh-token cookie.

let accessToken = null;
let currentUser = null;
let refreshing = null; // one refresh at a time, shared by concurrent callers

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function send(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
}

async function parse(res) {
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || `HTTP ${res.status}`, data);
  return data;
}

// Calls the API. If the access token expired (401), refreshes once and retries.
export async function api(method, path, body) {
  let res = await send(method, path, body);
  if (res.status === 401 && accessToken && (await refresh())) {
    res = await send(method, path, body);
  }
  return parse(res);
}

function useSession(session) {
  accessToken = session.token;
  currentUser = session.user;
  return currentUser;
}

// Returns true if the refresh cookie gave us a new access token.
export function refresh() {
  if (!refreshing) {
    refreshing = fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) return false;
        useSession(await res.json());
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export async function login(email, password) {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    credentials: 'same-origin',
  });
  return useSession(await parse(res));
}

export async function register(name, email, password) {
  const res = await fetch('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  return parse(res);
}

export async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  accessToken = null;
  currentUser = null;
  window.location.href = '/';
}

export function homeFor(user) {
  return user.role === 'PROFESSOR' ? '/professor.html' : '/student.html';
}

// For the professor and student pages: the logged-in user with the right role,
// or a redirect to the login page.
export async function requireUser(role) {
  if (!(await refresh())) {
    window.location.href = '/';
    return new Promise(() => {}); // never resolves: the page is leaving
  }
  if (currentUser.role !== role) {
    window.location.href = homeFor(currentUser);
    return new Promise(() => {});
  }
  return currentUser;
}

export function getCurrentUser() {
  return currentUser;
}
