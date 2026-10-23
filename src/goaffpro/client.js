// Minimal GoAffPro admin API client (read-only), authenticated with the
// store's access token from GoAffPro > Settings > API.
const BASE = 'https://api.goaffpro.com/v1/admin';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGoAffProClient({ accessToken }, fetchImpl = fetch) {
  if (!accessToken) throw new Error('GOAFFPRO_ACCESS_TOKEN is not set');

  async function get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        headers: { 'x-goaffpro-access-token': accessToken, Accept: 'application/json' },
      });
      if (res.status === 429 && attempt < 5) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`GoAffPro GET ${path} failed: ${res.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : {};
    }
  }

  // GoAffPro returns only the fields asked for, so callers pass a list.
  // Pages with limit/offset until a short page comes back. A page identical
  // to the previous one means offset is being ignored: stop rather than loop.
  async function* list(path, key, fields, { pageSize = 100, max = Infinity, onPage } = {}) {
    let offset = 0;
    let yielded = 0;
    let previous = null;
    while (yielded < max) {
      const data = await get(path, { fields: fields.join(','), limit: pageSize, offset });
      const rows = data[key] ?? [];
      const signature = rows.length ? JSON.stringify([rows[0], rows[rows.length - 1]]) : null;
      if (signature && signature === previous) {
        throw new Error(`GoAffPro ${path} returned the same page again at offset ${offset}; paging isn't working`);
      }
      previous = signature;
      onPage?.({ offset, rows: rows.length, total: yielded + rows.length });
      for (const row of rows) {
        if (yielded >= max) return;
        yielded++;
        yield row;
      }
      if (rows.length < pageSize) return;
      offset += pageSize;
    }
  }

  return { get, list };
}
