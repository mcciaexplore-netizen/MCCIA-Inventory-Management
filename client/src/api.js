export const getToken = () => localStorage.getItem('token');
export const setToken = (t) => (t ? localStorage.setItem('token', t) : localStorage.removeItem('token'));

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(getToken() && { Authorization: `Bearer ${getToken()}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (data === null && res.ok) throw new Error('Unexpected server response. Restart the server so it matches this version.');
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') { setToken(null); window.location.reload(); }
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
