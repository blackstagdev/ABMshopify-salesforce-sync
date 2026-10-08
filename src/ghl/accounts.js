// The configured GHL sub-accounts, each with its lead stage, wrapped with
// the lookups the processor needs. Reads from GHL only.
import { createGhlClient } from './client.js';

export function createGhlAccounts(ghlConfig, fetchImpl = fetch) {
  const accounts = {};
  for (const [name, cfg] of Object.entries(ghlConfig.accounts)) {
    if (!cfg.token || !cfg.locationId) continue;
    accounts[name] = wrapAccount(name, { ...cfg, adLeadTag: ghlConfig.adLeadTag }, createGhlClient(cfg, fetchImpl));
  }
  return accounts;
}

export function wrapAccount(name, cfg, client) {
  let fieldKeys = null;
  return {
    name,
    cfg,
    client,
    // Custom field id -> fieldKey, fetched once.
    async fieldKeys() {
      fieldKeys ??= Object.fromEntries((await client.customFields()).map((f) => [f.id, f.fieldKey ?? f.id]));
      return fieldKeys;
    },
    // The open opportunities in the lead stage for this event: the one named
    // in the webhook, or all of the contact's.
    async findOpportunities({ opportunityId, contactId }) {
      if (opportunityId) {
        const opp = await client.opportunity(opportunityId);
        return opp ? [opp] : [];
      }
      if (!contactId) return [];
      const { opportunities } = await client.searchOpportunities({
        pipelineId: cfg.pipelineId, stageId: cfg.stageId, contactId, status: 'open', limit: 20,
      });
      return opportunities;
    },
  };
}
