// Provider_ID__c is the upsert key for Account (Text, 30). The field
// reference says how a practice is identified across Shopify and AlphaSync
// is still an open decision, so the default strategy refuses to guess.
// Any other strategy must be agreed with the Salesforce team first.
const MAX_LENGTH = 30;

export function resolveProviderId(customer, opts) {
  const result = pick(customer, opts);
  if (result.value && result.value.length > MAX_LENGTH) {
    return { value: null, reason: `Provider ID "${result.value}" is longer than ${MAX_LENGTH} characters` };
  }
  return result;
}

function pick(customer, { providerIdStrategy, providerIdTagPrefix, providerIdPrefix }) {
  switch (providerIdStrategy) {
    case 'none':
      return {
        value: null,
        reason: 'PROVIDER_ID_STRATEGY is "none": the rule for identifying a practice between Shopify and Salesforce has not been decided',
      };

    // A customer tag such as "provider:ABM-00123".
    case 'customer_tag': {
      const prefix = providerIdTagPrefix.toLowerCase();
      const tags = String(customer?.tags || '').split(',').map((t) => t.trim());
      const tag = tags.find((t) => t.toLowerCase().startsWith(prefix));
      const value = tag?.slice(prefix.length).trim();
      return value
        ? { value }
        : { value: null, reason: `Shopify customer has no "${providerIdTagPrefix}" tag` };
    }

    // Derived from the Shopify customer id, e.g. "SHOPIFY-7382910".
    case 'shopify_customer_id':
      return customer?.id
        ? { value: `${providerIdPrefix}${customer.id}` }
        : { value: null, reason: 'No Shopify customer on this record (guest checkout?)' };

    default:
      return { value: null, reason: `Unknown PROVIDER_ID_STRATEGY "${providerIdStrategy}"` };
  }
}
