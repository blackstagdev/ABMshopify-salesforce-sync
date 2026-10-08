// Turns a Shopify webhook payload into a plan: the Salesforce operations to
// run, plus warnings and blockers. Building a plan never calls Salesforce,
// which is what makes dry-run mode possible.
//
// Field names and lengths come from the Salesforce field reference workbook
// (Lead, Account, Contact, Provider Order, Order Product tabs). Never add
// Salesforce-maintained fields (order counts, revenue, dates), owner fields,
// Fulfilment_Status__c (DO NOT SEND) or anything AlphaSync: this store is
// the Alpha BioMed line only.
import { resolveProviderId } from './providerId.js';
import { clean, text, compact, money, checkEmail } from './fields.js';

const CUSTOMER_TOPICS = new Set(['customers/create', 'customers/update']);
const ORDER_TOPICS = new Set(['orders/create', 'orders/updated', 'orders/paid', 'orders/cancelled']);

// "Send true once payment is received": refunded orders were paid first.
const PAID_STATUSES = new Set(['paid', 'partially_refunded', 'refunded']);

export function isOrderTopic(topic) {
  return ORDER_TOPICS.has(topic);
}

export function buildPlan(topic, payload, opts, context = {}) {
  if (CUSTOMER_TOPICS.has(topic)) {
    return planForCustomer({ customer: payload, address: payload.default_address, email: payload.email, phone: payload.phone }, opts, context, {});
  }
  if (ORDER_TOPICS.has(topic)) {
    return planForOrder(topic, payload, opts, context);
  }
  return null;
}

// The Shopify customer an event is about, for looking up its metafields.
export function customerIdFor(topic, payload) {
  if (CUSTOMER_TOPICS.has(topic)) return payload.id ?? null;
  if (ORDER_TOPICS.has(topic)) return payload.customer?.id ?? null;
  return null;
}

function planForOrder(topic, order, opts, context) {
  const customer = order.customer || null;
  const providerId = resolveProviderId(customer, opts, context);

  // With a Provider ID, the practice and contact are refreshed first so the
  // order can be linked. Without one, the order is still sent but unlinked:
  // Salesforce keeps it in an exception queue until someone links it, and
  // this service links it itself once the customer gets a Provider ID.
  let plan;
  if (providerId.value) {
    plan = planForCustomer({
      customer,
      address: order.billing_address || customer?.default_address,
      email: order.email || order.contact_email || customer?.email,
      phone: order.phone || customer?.phone || order.billing_address?.phone,
    }, opts, context, { isOrder: true, fromNewOrder: topic === 'orders/create' });
  } else {
    plan = { ops: [], warnings: [`Order sent without a Provider (unlinked): ${providerId.reason}`], blockers: [] };
  }

  const providerOrder = mapProviderOrder(order, opts, context);
  plan.blockers.push(...providerOrder.blockers);
  const op = {
    op: 'upsertOrder',
    shopifyOrderId: String(order.id),
    shopifyCustomerId: customer?.id != null ? String(customer.id) : null,
    orderNumber: order.name,
    linked: Boolean(providerId.value),
    cancelled: Boolean(order.cancelled_at),
    fields: providerOrder.fields,
    lines: providerOrder.lines,
  };

  if (opts.orderSyncEnabled) {
    plan.ops.push(op);
  } else {
    plan.warnings.push('Order not sent: ORDER_SYNC_ENABLED is false');
    plan.orderPreview = op;
  }
  return plan;
}

function planForCustomer({ customer, address, email, phone }, opts, context, { isOrder = false, fromNewOrder = false }) {
  const plan = { ops: [], warnings: [], blockers: [] };

  const providerId = resolveProviderId(customer, opts, context);
  if (!providerId.value) plan.blockers.push(providerId.reason);

  const firstName = clean(customer?.first_name || address?.first_name);
  const lastName = clean(customer?.last_name || address?.last_name);
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const validEmail = checkEmail(email, plan.warnings);

  const accountName = clean(address?.company) || fullName || validEmail;
  if (!accountName) plan.blockers.push('No company, name or email to use as the Account Name');

  // Only fields that are safe to refresh from Shopify on every update.
  const accountUpdate = compact({
    // Custom field added for this integration (not in the field reference
    // workbook). Recorded for reference only; Accounts are still matched on
    // Provider_ID__c.
    Shopify_ID__c: customer?.id != null ? String(customer.id) : undefined,
    Phone: text(phone, 40),
    Primary_Email__c: validEmail,
    ...billingAddress(address),
  });

  // Requested by the Salesforce team: Prospect until the practice has
  // ordered, then Active. Lapsed is left to reps. On updates the executor
  // decides whether it may write it (the Account trigger rejects the
  // integration once an Alpha BioMed Owner is assigned).
  const abmStatus = abmStatusFor(context, isOrder);

  plan.ops.push({
    op: 'upsertAccount',
    providerId: providerId.value,
    // Name is only set when the Account is created, so a name the sales
    // team has tidied up in Salesforce is not overwritten by Shopify.
    createFields: compact({ Name: text(accountName, 255), ...accountUpdate, ABM_Status__c: abmStatus }),
    updateFields: accountUpdate,
    abmStatus,
    fromNewOrder,
    shopifyCustomerId: customer?.id != null ? String(customer.id) : null,
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

function abmStatusFor(context, isOrder) {
  if (isOrder) return 'Active';
  if (context.numberOfOrders == null) return undefined;
  return context.numberOfOrders > 0 ? 'Active' : 'Prospect';
}

// Provider Order and its Order Product lines (Provider Order / Order Product
// tabs). Neither object has an external ID, so the executor keeps the
// Salesforce Ids to update them later.
export function mapProviderOrder(order, opts, context = {}) {
  const blockers = [];
  const cancelled = Boolean(order.cancelled_at);

  // The order total, not calculated from the lines. Shopify's current total
  // already reflects edits and refunds. A cancelled order counts for nothing.
  const amount = cancelled ? 0 : money(order.current_total_price ?? order.total_price);
  if (amount === undefined) blockers.push('Order has no total');

  // The date the practice placed the order, as YYYY-MM-DD. Shopify sends
  // created_at in the store's time zone, so its date part is the local date.
  const orderDate = /^\d{4}-\d{2}-\d{2}/.test(order.created_at ?? '') ? order.created_at.slice(0, 10) : undefined;
  if (!orderDate) blockers.push('Order has no created_at date');

  const fields = compact({
    Line_of_Business__c: opts.lineOfBusiness,
    Order_Amount__c: amount,
    Order_Date__c: orderDate,
    // The customer's first Shopify order is New, later ones Reorder. Guests
    // and unknown history are left blank, which Salesforce treats as a real
    // order.
    Order_Type__c: order.customer && typeof context.isFirstOrder === 'boolean'
      ? (context.isFirstOrder ? 'New' : 'Reorder')
      : undefined,
    Paid__c: PAID_STATUSES.has(order.financial_status),
  });

  const lines = (order.line_items || []).map((li) => {
    const quantity = Number(li.current_quantity ?? li.quantity ?? 0);
    const orderedQuantity = Number(li.quantity) || quantity || 1;
    const discount = (li.discount_allocations || []).reduce((sum, d) => sum + Number(d.amount || 0), 0);
    const name = [clean(li.title), clean(li.variant_title)].filter(Boolean).join(' - ') || 'Unnamed product';
    return {
      shopifyLineId: String(li.id),
      // Removed in an order edit, or fully refunded.
      remove: quantity <= 0,
      fields: compact({
        Quantity__c: quantity,
        // "Price for one unit as charged on this order": after discounts.
        Unit_Price__c: money(Number(li.price) - discount / orderedQuantity),
        Product_Name__c: text(name, 255),
      }),
    };
  });

  return { fields, lines, blockers };
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
