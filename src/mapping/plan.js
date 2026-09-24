// Turns a Shopify webhook payload into a plan: the Salesforce operations to
// run, plus warnings and blockers. Building a plan never calls Salesforce,
// which is what makes dry-run mode possible.
//
// Field names and lengths come from the Salesforce field reference workbook
// (production org, 18 Sep 2026). Never add Salesforce-maintained fields
// (order counts, revenue, dates) or the guarded status/owner fields here.
import { resolveProviderId } from './providerId.js';

const CUSTOMER_TOPICS = new Set(['customers/create', 'customers/update']);
const ORDER_TOPICS = new Set(['orders/create', 'orders/updated', 'orders/paid', 'orders/cancelled']);

export function buildPlan(topic, payload, opts) {
  if (CUSTOMER_TOPICS.has(topic)) {
    return planForCustomer({ customer: payload, address: payload.default_address, email: payload.email, phone: payload.phone }, opts);
  }
  if (ORDER_TOPICS.has(topic)) {
    return planForOrder(payload, opts);
  }
  return null;
}

function planForOrder(order, opts) {
  const customer = order.customer || null;
  const plan = planForCustomer({
    customer,
    address: order.billing_address || customer?.default_address,
    email: order.email || order.contact_email || customer?.email,
    phone: order.phone || customer?.phone || order.billing_address?.phone,
  }, opts);

  const preview = mapOrder(order, opts);
  if (opts.orderSyncEnabled) {
    plan.ops.push({ op: 'upsertOrder', order: preview });
  } else {
    plan.warnings.push('Order not sent: ORDER_SYNC_ENABLED is false until the Provider_Order__c fields are confirmed');
    plan.orderPreview = preview;
  }
  return plan;
}

function planForCustomer({ customer, address, email, phone }, opts) {
  const plan = { ops: [], warnings: [], blockers: [] };

  const providerId = resolveProviderId(customer, opts);
  if (!providerId.value) plan.blockers.push(providerId.reason);

  const firstName = clean(customer?.first_name || address?.first_name);
  const lastName = clean(customer?.last_name || address?.last_name);
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const validEmail = checkEmail(email, plan);

  const accountName = clean(address?.company) || fullName || validEmail;
  if (!accountName) plan.blockers.push('No company, name or email to use as the Account Name');

  // Only fields that are safe to refresh from Shopify on every update.
  const accountUpdate = compact({
    Phone: text(phone, 40),
    Primary_Email__c: validEmail,
    ...billingAddress(address),
  });

  plan.ops.push({
    op: 'upsertAccount',
    providerId: providerId.value,
    // Name is only set when the Account is created, so a name the sales
    // team has tidied up in Salesforce is not overwritten by Shopify.
    createFields: { Name: text(accountName, 255), ...accountUpdate },
    updateFields: accountUpdate,
  });

  if (validEmail) {
    let contactLastName = text(lastName, 80);
    if (!contactLastName) {
      contactLastName = text(validEmail.split('@')[0], 80);
      plan.warnings.push('Shopify customer has no last name; the email address is used as the Contact LastName');
    }
    plan.ops.push({
      op: 'upsertContact',
      email: validEmail,
      fields: compact({
        FirstName: text(firstName, 40),
        LastName: contactLastName,
        Email: validEmail,
        Phone: text(phone, 40),
        ...mailingAddress(address),
      }),
    });
  } else {
    plan.warnings.push('No usable email address, so no Contact is created (it could not be matched on later updates)');
  }

  return plan;
}

// A neutral order shape. It becomes a Provider_Order__c payload once that
// object's fields are confirmed (see salesforce/executor.js).
export function mapOrder(order, opts) {
  return compact({
    shopifyOrderId: String(order.id),
    orderNumber: order.name,
    lineOfBusiness: opts.lineOfBusiness,
    createdAt: order.created_at,
    processedAt: order.processed_at,
    cancelledAt: order.cancelled_at,
    currency: order.currency,
    totalPrice: order.current_total_price ?? order.total_price,
    subtotalPrice: order.current_subtotal_price ?? order.subtotal_price,
    totalTax: order.current_total_tax ?? order.total_tax,
    totalDiscounts: order.current_total_discounts ?? order.total_discounts,
    financialStatus: order.financial_status,
    fulfillmentStatus: order.fulfillment_status,
    lineItems: (order.line_items || []).map((li) => compact({
      sku: li.sku,
      title: li.title,
      variantTitle: li.variant_title,
      productId: li.product_id != null ? String(li.product_id) : undefined,
      variantId: li.variant_id != null ? String(li.variant_id) : undefined,
      quantity: li.quantity,
      price: li.price,
    })),
  });
}

// Compound address fields are read only; send the components.
function billingAddress(a) {
  return {
    BillingStreet: street(a),
    BillingCity: text(a?.city, 40),
    BillingState: text(a?.province, 80),
    BillingPostalCode: text(a?.zip, 20),
    BillingCountry: text(a?.country, 80),
  };
}

function mailingAddress(a) {
  return {
    MailingStreet: street(a),
    MailingCity: text(a?.city, 40),
    MailingState: text(a?.province, 80),
    MailingPostalCode: text(a?.zip, 20),
    MailingCountry: text(a?.country, 80),
  };
}

function street(a) {
  return text([clean(a?.address1), clean(a?.address2)].filter(Boolean).join('\n'), 255);
}

// Salesforce Email fields hold 80 characters; truncating would corrupt it.
function checkEmail(email, plan) {
  const value = clean(email)?.toLowerCase();
  if (!value) return undefined;
  if (value.length > 80 || !value.includes('@')) {
    plan.warnings.push(`Email "${value}" is not usable in Salesforce and was skipped`);
    return undefined;
  }
  return value;
}

function clean(value) {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

function text(value, max) {
  const s = clean(value);
  return s && s.length > max ? s.slice(0, max) : s;
}

// Drop empty values so a blank in Shopify never wipes data in Salesforce.
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}
