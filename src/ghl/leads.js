// GHL opportunity + contact -> Salesforce Lead (Lead tab of the field
// reference). Pure: no I/O.
//
// Never sent: OwnerId (Salesforce assigns leads by state, or round-robins
// Black Stag ad leads), Self_Sourced__c, NPI/EIN and reseller details.
import { clean, text, compact, checkEmail } from '../mapping/fields.js';

// cfg: { lineOfBusiness, adLeadTag }
// fieldKeyById: GHL custom field id -> fieldKey, e.g. "contact.clinic_name"
export function mapLead(opportunity, contact, fieldKeyById, cfg) {
  const warnings = [];
  const blockers = [];
  const custom = customValues(contact, fieldKeyById);

  const firstName = text(contact?.firstName, 40);
  const email = checkEmail(contact?.email, warnings);
  const fullName = [clean(contact?.firstName), clean(contact?.lastName)].filter(Boolean).join(' ');

  // Alpha BioMed keeps the practice in Company; Alpha Sync in "Clinic Name".
  const company = clean(contact?.companyName) || clean(custom['contact.clinic_name']) || fullName || email;
  if (!company) blockers.push('No company, clinic name, name or email to use as the Lead Company');
  if (company && company === (fullName || email)) warnings.push('No company or clinic name; the person is used as the Lead Company');

  let lastName = text(contact?.lastName, 80);
  if (!lastName) {
    lastName = text(email?.split('@')[0] ?? company, 80);
    warnings.push('GHL contact has no last name; a fallback is used as the Lead Last Name');
  }

  // Exact tag match: "non-bsd-lead" must not count as an ad lead.
  const tags = (contact?.tags ?? []).map((t) => String(t).trim().toLowerCase());
  const isAdLead = tags.includes(cfg.adLeadTag.toLowerCase());

  const fields = compact({
    FirstName: firstName,
    LastName: lastName,
    Company: text(company, 255),
    Email: email,
    Phone: text(contact?.phone, 40),
    Street: text([clean(contact?.address1), clean(contact?.address2)].filter(Boolean).join('\n'), 255),
    City: text(contact?.city, 40),
    State: text(contact?.state, 80),
    PostalCode: text(contact?.postalCode, 20),
    Country: text(contact?.country, 80),
    Website: text(contact?.website, 255),
    Title: text(custom['contact.title'], 128),
    Suffix: text(custom['contact.suffix'], 40),
    // Required: decides which line's reps the lead is routed to.
    Line_of_Business__c: cfg.lineOfBusiness,
    // "Black Stag" leads are round-robined across the line's reps.
    LeadSource: isAdLead ? 'Black Stag' : undefined,
    // "Send the original creation time from the source system if you have it."
    Entered_Salesforce__c: isoDate(opportunity?.createdAt ?? contact?.dateAdded),
  });

  if (!fields.State) warnings.push('No state: Salesforce sends leads without a matching territory to the fallback owner');
  return { fields, warnings, blockers, isAdLead };
}

// An opportunity is synced only while it is open in the configured stage.
export function isLeadOpportunity(opportunity, cfg) {
  return Boolean(opportunity)
    && opportunity.pipelineId === cfg.pipelineId
    && (opportunity.pipelineStageId ?? opportunity.pipelineStageUId) === cfg.stageId
    && String(opportunity.status ?? '').toLowerCase() === 'open';
}

function customValues(contact, fieldKeyById) {
  const out = {};
  for (const cf of contact?.customFields ?? contact?.customField ?? []) {
    const key = fieldKeyById[cf.id];
    if (key) out[key] = cf.value ?? cf.fieldValue;
  }
  return out;
}

function isoDate(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
}
