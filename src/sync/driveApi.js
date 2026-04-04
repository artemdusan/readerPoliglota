const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

async function apiFetch(url, opts = {}) {
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.status);
    throw new Error(`Drive API ${resp.status}: ${text}`);
  }
  return resp.json();
}

// --- Generic file helpers ---

export async function findFile(name, token) {
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const data = await apiFetch(
    `${BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.files?.[0] ?? null;
}

export async function upsertFile(name, data, token) {
  const body = JSON.stringify(data);
  const existing = await findFile(name, token);

  if (existing) {
    const resp = await fetch(`${UPLOAD_BASE}/files/${existing.id}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!resp.ok) throw new Error(`Drive patch ${resp.status}`);
  } else {
    const boundary = 'vr_boundary';
    const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
    const multipart = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      meta,
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      body,
      `--${boundary}--`,
    ].join('\r\n');

    const resp = await fetch(`${UPLOAD_BASE}/files?uploadType=multipart`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipart,
    });
    if (!resp.ok) throw new Error(`Drive create ${resp.status}`);
  }
}

export async function downloadFile(fileId, token) {
  const resp = await fetch(`${BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Drive download ${resp.status}`);
  return resp.json();
}

// --- Progress files ---

export async function findProgressFile(bookId, token) {
  return findFile(`progress_${bookId}.json`, token);
}

export async function upsertProgressFile(bookId, data, token) {
  return upsertFile(`progress_${bookId}.json`, data, token);
}

export async function listAllProgressFiles(token) {
  const q = encodeURIComponent("name contains 'progress_' and trashed=false");
  const data = await apiFetch(
    `${BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)&pageSize=1000`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.files ?? [];
}

// --- Book files ---

export async function listAllBookFiles(token) {
  const q = encodeURIComponent("name contains 'book_' and trashed=false");
  const data = await apiFetch(
    `${BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)&pageSize=1000`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.files ?? [];
}
