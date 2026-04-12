// Cloudflare JWT auth — replaces googleAuth.js
// Token is stored in Dexie settings table and cached in memory.

import { getSetting, setSetting } from '../db';
import { getWorkerUrl } from '../config/workerUrl';
import { resetSyncActivity } from './syncActivity';

const WORKER_URL = getWorkerUrl();

let _token = null;
let _username = null;
let _listeners = [];

function normalizeAuthIdentifier(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function notify() {
  _listeners.forEach((fn) => fn(isLoggedIn(), _username));
}

async function persistAuthState(token, username) {
  _token = token;
  _username = username;
  resetSyncActivity();
  await Promise.all([
    setSetting('cfToken', token),
    setSetting('cfUsername', username),
  ]);
}

async function fetchCurrentUsername(token) {
  const resp = await fetch(`${WORKER_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || 'Nie udało się pobrać profilu');
  }

  const data = await resp.json();
  return normalizeAuthIdentifier(data.username);
}

export function isLoggedIn() {
  return !!_token;
}

export function getToken() {
  return _token;
}

export function getUsername() {
  return _username;
}

/** Subscribe to auth state changes. Returns unsubscribe function. */
export function onAuthChange(fn) {
  _listeners.push(fn);
  fn(isLoggedIn(), _username);
  return () => {
    _listeners = _listeners.filter((listener) => listener !== fn);
  };
}

/** Call once on app startup — loads auth data from Dexie into memory. */
export async function initCfAuth() {
  _token = await getSetting('cfToken', null);
  _username = normalizeAuthIdentifier(await getSetting('cfUsername', null));
  notify();

  if (_token && !_username) {
    try {
      _username = await fetchCurrentUsername(_token);
      await setSetting('cfUsername', _username);
      notify();
    } catch {}
  }
}

export async function login(username, password) {
  const normalizedUsername = normalizeAuthIdentifier(username);
  const resp = await fetch(`${WORKER_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: normalizedUsername, password }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || 'Błąd logowania');
  }

  const { token } = await resp.json();
  await persistAuthState(token, normalizedUsername);
  notify();
}

export async function register(username, password) {
  const normalizedUsername = normalizeAuthIdentifier(username);
  const resp = await fetch(`${WORKER_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: normalizedUsername, password }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || 'Błąd rejestracji');
  }

  const { token } = await resp.json();
  await persistAuthState(token, normalizedUsername);
  notify();
}

export async function logout() {
  await persistAuthState(null, null);
  notify();
}
