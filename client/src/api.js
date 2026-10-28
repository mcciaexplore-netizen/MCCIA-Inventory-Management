// Auth is a server-set httpOnly cookie (not readable or stored by this client), sent automatically
// by the browser on same-origin requests; `credentials: 'include'` also covers a configured
// cross-origin deployment (CORS_ORIGIN) paired with the server's matching credentials setting.
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (data === null && res.ok) throw new Error('Unexpected server response. Restart the server so it matches this version.');
  if (!res.ok) {
    // A 401 mid-session means it expired: reload into the sign-in flow. The startup /api/me check
    // and the login form handle their own 401s (reloading on those would loop forever).
    if (res.status === 401 && url !== '/api/login' && url !== '/api/me') window.location.reload();
    throw new Error(data?.error || 'Request failed');
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b || {}),
  put: (u, b) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
};

// Downloads a binary response (e.g. a generated PO document) and saves it as a local file.
export async function downloadFile(url, filename) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (res.status === 401) window.location.reload();
    throw new Error(data?.error || 'Download failed');
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

// Photo uploads go through multipart/form-data, not the JSON helper above.
export async function uploadPhoto(url, file) {
  const fd = new FormData();
  fd.append('photo', file);
  const res = await fetch(url, { method: 'POST', credentials: 'include', body: fd });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) window.location.reload();
    throw new Error(data?.error || 'Upload failed');
  }
  return data;
}
