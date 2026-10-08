// Minimal GoHighLevel (LeadConnector API v2) client for one sub-account,
// using a Private Integration token. Read-only for now.
const BASE = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGhlClient({ token, locationId }, fetchImpl = fetch) {
  if (!token || !locationId) throw new Error('GHL token and location id are required');

  async function get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Version: API_VERSION, Accept: 'application/json' },
      });
      if (res.status === 429 && attempt < 5) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`GHL GET ${path} failed: ${res.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : {};
    }
  }

  return {
    locationId,
    async pipelines() {
      return (await get('/opportunities/pipelines', { locationId })).pipelines ?? [];
    },
    async customFields() {
      return (await get(`/locations/${locationId}/customFields`)).customFields ?? [];
    },
    async contact(id) {
      return (await get(`/contacts/${id}`)).contact ?? null;
    },
    async opportunity(id) {
      return (await get(`/opportunities/${id}`)).opportunity ?? null;
    },
    // One page of opportunities in a pipeline stage. Pass the returned
    // meta.startAfter / meta.startAfterId to get the next page.
    async searchOpportunities({ pipelineId, stageId, contactId, status, limit = 100, startAfter, startAfterId }) {
      const data = await get('/opportunities/search', {
        location_id: locationId,
        pipeline_id: pipelineId,
        pipeline_stage_id: stageId,
        contact_id: contactId,
        status,
        limit,
        startAfter,
        startAfterId,
      });
      return { opportunities: data.opportunities ?? [], meta: data.meta ?? {} };
    },
  };
}

// The two sub-accounts and the stage that holds new leads in each.
export const GHL_ACCOUNTS = {
  abm: { label: 'Alpha BioMed', lineOfBusiness: 'Alpha BioMed', env: 'GHL_ABM', stage: 'New Providers' },
  sync: { label: 'Alpha Sync', lineOfBusiness: 'AlphaSync', env: 'GHL_SYNC', stage: 'New Leads' },
};
