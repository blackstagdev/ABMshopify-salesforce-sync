// GHL opportunity + contact -> Salesforce Lead (Lead tab of the field
// reference). Pure: no I/O.
//
// Never sent: OwnerId (Salesforce assigns leads by state, or round-robins
// Black Stag ad leads), Self_Sourced__c, Entered_Salesforce__c, NPI/EIN and
// reseller details.
import { clean, text, compact, checkEmail } from '../mapping/fields.js';

// cfg: { lineOfBusiness, adLeadTag, leadIdField? }
// fieldKeyById: GHL custom field id -> fieldKey, e.g. "contact.clinic_name"
// status: the Lead Status for this opportunity (see leadStatusFor)
export function mapLead(opportunity, contact, fieldKeyById, cfg, status) {
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
    // From the GHL stage, per the mapping in config.js.
    Status: status,
    // The GHL contact ID, once the Salesforce team has added a field for it.
    ...(cfg.leadIdField && contact?.id ? { [cfg.leadIdField]: String(contact.id) } : {}),
    // Entered_Salesforce__c is left blank on purpose: the Salesforce team
    // asked for it (Oct 2026), since Salesforce stamps it and it starts their
    // follow-up alerts.
  });

  if (!fields.State) warnings.push('No state: Salesforce sends leads without a matching territory to the fallback owner');
  return { fields, warnings, blockers, isAdLead };
}

// The Salesforce Lead Status for an opportunity, or null when it is not a
// lead we send (other pipeline, or a stage that isn't mapped). Lost and
// abandoned opportunities are "Unresponsive", as Alpha BioMed decided.
export function leadStatusFor(opportunity, cfg) {
  if (!opportunity || opportunity.pipelineId !== cfg.pipelineId) return null;
  const stageStatus = cfg.stageStatus?.[opportunity.pipelineStageId ?? opportunity.pipelineStageUId];
  if (!stageStatus) return null;
  const state = String(opportunity.status ?? '').toLowerCase();
  return state === 'lost' || state === 'abandoned' ? 'Unresponsive' : stageStatus;
}

function customValues(contact, fieldKeyById) {
  const out = {};
  for (const cf of contact?.customFields ?? contact?.customField ?? []) {
    const key = fieldKeyById[cf.id];
    if (key) out[key] = cf.value ?? cf.fieldValue;
  }
  return out;
}
