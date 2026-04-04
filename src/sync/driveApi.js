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

export async function findProgressFile(bookId, token) {
  const q = encodeURIComponent(`name='progress_${bookId}.json' and trashed=false`);
  const data = await apiFetch(
    `${BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.files?.[0] ?? null;
}

export async function listAllProgressFiles(token) {
  const q = encodeURIComponent("name contains 'progress_' and trashed=false");
  const data = await apiFetch(
    `${BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id,name)&pageSize=1000`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data.files ?? [];
}

export async function downloadFile(fileId, token) {
  const resp = await fetch(`${BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Drive download ${resp.status}`);
  return resp.json();
}

export async function upsertProgressFile(bookId, data, token) {
  const body = JSON.stringify(data);
  const existing = await findProgressFile(bookId, token);

  if (existing) {
    // Update content only (no metadata change needed)
    const resp = await fetch(
      `${UPLOAD_BASE}/files/${existing.id}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
      }
    );
    if (!resp.ok) throw new Error(`Drive patch ${resp.status}`);
  } else {
    // Create new file with multipart upload
    const boundary = 'vr_boundary';
    const meta = JSON.stringify({ name: `progress_${bookId}.json`, parents: ['appDataFolder'] });
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
