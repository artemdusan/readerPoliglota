// Cloudflare JWT auth — replaces googleAuth.js
// Token is stored in Dexie settings table (key: 'cfToken') and cached in memory.

import { getSetting, setSetting } from '../db';
import { getWorkerUrl } from '../config/workerUrl';

const WORKER_URL = getWorkerUrl();

let _token = null;
let _listeners = [];

function notify() {
  _listeners.forEach(fn => fn(isLoggedIn()));
}

export function isLoggedIn() {
  return !!_token;
}

export function getToken() {
  return _token;
}

/** Subscribe to auth state changes. Returns unsubscribe function. */
export function onAuthChange(fn) {
  _listeners.push(fn);
  fn(isLoggedIn());
  return () => { _listeners = _listeners.filter(f => f !== fn); };
}

/** Call once on app startup — loads token from Dexie into memory. */
export async function initCfAuth() {
  _token = await getSetting('cfToken', null);
  notify();
}

export async function login(username, password) {
  const resp = await fetch(`${WORKER_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || 'Błąd logowania');
  }
  const { token } = await resp.json();
  _token = token;
  await setSetting('cfToken', token);
  notify();
}

export async function register(username, password) {
  const resp = await fetch(`${WORKER_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || 'Błąd rejestracji');
  }
  const { token } = await resp.json();
  _token = token;
  await setSetting('cfToken', token);
  notify();
}

export async function logout() {
  _token = null;
  await setSetting('cfToken', null);
  notify();
}
