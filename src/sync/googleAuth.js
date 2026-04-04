const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const GSI_URL = 'https://accounts.google.com/gsi/client';

let _client = null;
let _clientId = null;
let _token = null;
let _expiry = 0;
let _pending = [];
let _listeners = [];

function notify() {
  _listeners.forEach(fn => fn(isSignedIn()));
}

function onToken(resp) {
  if (resp.error) {
    _token = null;
    _expiry = 0;
    const err = new Error(resp.error);
    err.code = resp.error;
    _pending.forEach(({ reject }) => reject(err));
  } else {
    _token = resp.access_token;
    _expiry = Date.now() + (resp.expires_in - 60) * 1000;
    _pending.forEach(({ resolve }) => resolve(_token));
  }
  _pending = [];
  notify();
}

async function loadGSI() {
  if (window.google?.accounts) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GSI_URL;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export async function initGoogleAuth(clientId) {
  if (_clientId === clientId && _client) return;
  _clientId = clientId;
  await loadGSI();
  _client = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    prompt: '',
    callback: onToken,
  });
}

export function isSignedIn() {
  return !!_token && Date.now() < _expiry;
}

export function onAuthChange(fn) {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(f => f !== fn); };
}

// Silent token retrieval — rejects with code 'interaction_required' if not signed in
export function getAccessToken() {
  if (isSignedIn()) return Promise.resolve(_token);
  if (!_client) return Promise.reject(Object.assign(new Error('not initialized'), { code: 'not_initialized' }));
  return new Promise((resolve, reject) => {
    _pending.push({ resolve, reject });
    _client.requestAccessToken();
  });
}

// Interactive sign-in — must be called from a user gesture
export function signIn() {
  if (!_client) return Promise.reject(Object.assign(new Error('not initialized'), { code: 'not_initialized' }));
  return new Promise((resolve, reject) => {
    _pending.push({ resolve, reject });
    _client.requestAccessToken({ prompt: 'select_account' });
  });
}

export function signOut() {
  if (_token) window.google?.accounts.oauth2.revoke(_token, () => {});
  _token = null;
  _expiry = 0;
  notify();
}
