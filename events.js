// backend/events.js
import { getSecret } from 'wix-secrets-backend';
import { contacts } from 'wix-crm-backend';
import { orders as pricingOrders } from 'wix-pricing-plans-backend';
import { fetch } from 'wix-fetch';

/* ------------------------------- Config ---------------------------------- */
// Drop ALL Pricing Plans *purchase* pings; rely on Invoice/Stores/Pay API
const DISABLE_PLANS_PURCHASE_ALERTS = true;
// Renewals: only send if we have Amount AND Email (name optional)
const REQUIRE_EMAIL_FOR_RENEWALS = true;

/* -------------------------------- Helpers -------------------------------- */

function escHtml(s = '') {
  if (s && typeof s === 'object') {
    try { s = JSON.stringify(s); } catch (_) { s = String(s); }
  }
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

function fmtMoney(amount, currency) {
  if (typeof amount === 'number') return `${amount.toFixed(2)} ${currency || ''}`.trim();
  if (amount && typeof amount.value === 'number') return `${amount.value.toFixed(2)} ${amount.currency || currency || ''}`.trim();
  if (amount && amount.amount != null) return `${amount.amount} ${amount.currency || currency || ''}`.trim();
  return currency ? `0.00 ${currency}` : '—';
}

async function sendTelegram(text) {
  const token = await getSecret('TELEGRAM_BOT_TOKEN');
  const chatId = await getSecret('TELEGRAM_CHAT_ID');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'post',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  if (!res.ok) console.error('Telegram sendMessage failed', res.status, await res.text());
}

function titleCaseWords(str = '') {
  return str.replace(/\s+/g, ' ').trim().split(' ')
    .map(w => (w ? (w[0].toUpperCase() + w.slice(1)) : ''))
    .join(' ');
}
function nameFromEmail(email = '') {
  const local = String(email).split('@')[0] || '';
  const cleaned = local.replace(/[._\-]+/g, ' ').replace(/\d{2,}/g, m => m);
  return titleCaseWords(cleaned) || '—';
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}
function firstOf(obj, paths, fallback = undefined) {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

function sumPayments(inv) {
  const arr = inv?.payments || inv?.paymentHistory || [];
  if (!Array.isArray(arr) || !arr.length) return { amount: undefined, currency: undefined };
  let total = 0;
  let currency = undefined;
  for (const p of arr) {
    const a = p?.amount?.amount ?? p?.amount?.value ?? p?.amount ?? 0;
    if (typeof a === 'number') total += a;
    currency = currency ||
      p?.amount?.currency || p?.amount?.currencyCode || p?.currency || p?.currencyCode;
  }
  return { amount: total || undefined, currency };
}

async function resolveBuyer(buyer = {}) {
  let first = buyer.firstName || buyer.name?.first || '';
  let last  = buyer.lastName  || buyer.name?.last  || '';
  let email = buyer.email || buyer.emails?.[0];
  let name  = buyer.name && typeof buyer.name === 'string' ? buyer.name : '';

  // If only email (no contactId), try CRM lookup by email
  const contactId = buyer.contactId || buyer.contact?.contactId || buyer.contactID;
  if ((!first && !last && !name) && email && !contactId) {
    try {
      const q = await contacts.queryContacts().eq('info.emails.email', email).find();
      const c = q?.items?.[0];
      if (c) {
        first = c?.info?.name?.first || c?.name?.first || first;
        last  = c?.info?.name?.last  || c?.name?.last  || last;
        email = c?.primaryEmail?.email || c?.emails?.[0]?.email || email;
      }
    } catch (e) {
      console.warn('contacts.queryContacts by email failed:', e);
    }
  }

  // If we do have contactId, use CRM record
  if ((!first && !last && !name) || !email) {
    const cid = contactId;
    if (cid) {
      try {
        const c = await contacts.getContact(cid);
        first = first || c?.info?.name?.first || c?.name?.first || '';
        last  = last  || c?.info?.name?.last  || c?.name?.last  || '';
        email = email || c?.primaryEmail?.email || c?.emails?.[0]?.email || '';
      } catch (e) {
        console.warn('contacts.getContact failed:', e);
      }
    }
  }

  const display = [first, last].filter(Boolean).join(' ') || name || (email ? nameFromEmail(email) : '—');
  return { name: display, email: email || '—' };
}

function getPlanNameFromOrder(order = {}) {
  return order.plan?.name || order.planName || order.plan?.title || order.plan?.planName || '—';
}
function getAmountFromOrder(order = {}) {
  const pricing = order.pricing || order.priceDetails || {};
  const total = pricing.totalPrice || pricing.total || order.price || order.amount;
  const currency = total?.currency || pricing?.currency || order.currency;
  const amount = typeof total === 'number'
    ? total
    : (typeof total?.amount === 'number' ? total.amount : total?.value);
  return { amount, currency };
}

/** Unified alert so all sources look identical */
async function alertPayment({ source, name, email, plan, amount, currency, id }) {
  const msg =
    `<b>✅ Payment received (${escHtml(source)})</b>\n` +
    `🌐 <b>Site:</b> hts20.net\n` +
    `👤 <b>Name:</b> ${escHtml(name || '—')}\n` +
    `📧 <b>Email:</b> ${escHtml(email || '—')}\n` +
    `🗒️ <b>Plan:</b> ${escHtml(plan || '—')}\n` +
    `💵 <b>Amount:</b> ${escHtml(fmtMoney(amount, currency))}\n` +
    `🧾 <b>ID:</b> ${escHtml(id || '—')}`;
  await sendTelegram(msg);
}

/* ----------------------- Pricing Plans: Purchased ------------------------ */
// SUPPRESSED to avoid duplicate/noisy alerts (rely on Invoice/Pay API instead)
export async function wixPaidPlans_onOrderPurchased(event) {
  try {
    if (DISABLE_PLANS_PURCHASE_ALERTS) {
      const orderId = event?.order?.id || event?.orderId || event?.id;
      console.warn('Suppressed Pricing Plans purchase alert for order', orderId);
      return;
    }
  } catch (err) {
    console.error('wixPaidPlans_onOrderPurchased error', err);
  }
}
export async function wixPaidPlans_onPlanPurchased(event) {
  return wixPaidPlans_onOrderPurchased(event);
}

/* --------------- Pricing Plans: Auto-Renewal (subscription) -------------- */
export async function wixPricingPlans_onOrderCycleStarted(event) {
  return handlePricingPlansCycle(event);
}
export async function wixPaidPlans_onOrderCycleStarted(event) {
  return handlePricingPlansCycle(event);
}

async function handlePricingPlansCycle(event) {
  try {
    const orderId = firstOf(event, ['orderId','order.id','id']);
    let order = event?.order;

    if (!order && orderId) {
      try {
        order = await pricingOrders.getOrder(orderId);
      } catch (e) {
        console.warn('pricingOrders.getOrder failed:', e);
      }
    }

    const buyer = await resolveBuyer(order?.buyer || event?.buyer || {});
    const plan = getPlanNameFromOrder(order || {});
    const { amount, currency } = getAmountFromOrder(order || {});

    const hasEmail = !!(buyer?.email && buyer.email !== '—');
    const hasAmount = amount !== undefined && amount !== null;

    if (REQUIRE_EMAIL_FOR_RENEWALS && !(hasEmail && hasAmount)) {
      console.warn('Skipping renewal alert (requires email + amount).');
      return;
    }

    await alertPayment({
      source: 'Pricing Plans (Renewal)',
      name: buyer.name,               // may be derived from email
      email: buyer.email,
      plan,
      amount,
      currency,
      id: orderId || order?.id
    });
  } catch (err) {
    console.error('wixPricingPlans_onOrderCycleStarted error', err);
  }
}

/* ----------------------------- Pay API layer ----------------------------- */
export async function wixPay_onPaymentUpdate(event) {
  try {
    const status = String(event?.status || '').toLowerCase();
    if (!status || /(fail|cancel)/.test(status)) return;

    const p = event?.payment || {};
    const buyer = await resolveBuyer(p.userInfo || p.buyer || {});
    const amount = p?.amount || p?.price;
    const currency = p?.currency;

    await alertPayment({
      source: `Pay API: ${event.status || 'Successful'}`,
      name: buyer.name, email: buyer.email, plan: '—',
      amount, currency, id: p.id || p.paymentId
    });
  } catch (err) {
    console.error('wixPay_onPaymentUpdate error', err);
  }
}

/* --------------------------- Wix Stores checkout ------------------------- */
export async function wixStores_onOrderPaid(event) {
  try {
    const order = event?.order || event;
    const buyer = await resolveBuyer(order?.buyerInfo || order?.buyer || {});
    const t = order?.priceSummary?.total || order?.amountPaid || order?.totals?.total || {};
    const currency = t?.currency || order?.currency;
    const amount = typeof t === 'number' ? t : (t?.amount ?? t?.value);

    await alertPayment({
      source: 'Stores',
      name: buyer.name, email: buyer.email, plan: order?.cart?.lineItems?.[0]?.name || '—',
      amount, currency, id: order?.id || order?.number
    });
  } catch (err) {
    console.error('wixStores_onOrderPaid error', err);
  }
}
export async function wixEcom_onOrderPaid(event) {
  return wixStores_onOrderPaid(event);
}

/* ------------------------------ Billing: AR ------------------------------ */
export async function wixBilling_onInvoicePaid(event) {
  try {
    const inv = event?.invoice || event || {};

    // --- ID (normalize objects) ---
    const rawId = firstOf(inv, [
      'id','_id','number','invoiceId','metadata.id','invoice.id'
    ], '');
    const id = typeof rawId === 'object'
      ? (rawId.id || rawId._id || rawId.number || JSON.stringify(rawId))
      : rawId;

    // --- Buyer (many shapes + CRM fallbacks) ---
    const candidateBuyer = {
      firstName: firstOf(inv, [
        'buyer.firstName','customer.firstName','issuedTo.firstName','payer.firstName','recipient.firstName'
      ]),
      lastName: firstOf(inv, [
        'buyer.lastName','customer.lastName','issuedTo.lastName','payer.lastName','recipient.lastName'
      ]),
      name: firstOf(inv, [
        'buyer.name','buyer.fullName',
        'customer.name','customer.fullName',
        'issuedTo.name','issuedTo.fullName',
        'payer.name','payer.fullName',
        'recipient.name','recipient.fullName'
      ]),
      email: firstOf(inv, [
        'buyer.email','customer.email','issuedTo.email','payer.email','recipient.email'
      ]),
      contactId: firstOf(inv, [
        'buyer.contactId','buyer.contactID',
        'customer.contactId','customer.contactID',
        'issuedTo.contactId','issuedTo.contactID',
        'payer.contactId','payer.contactID',
        'contactId'
      ])
    };
    const buyerResolved = await resolveBuyer(candidateBuyer);
    const buyer = buyerResolved.email && buyerResolved.name ? buyerResolved
                  : { ...buyerResolved, name: buyerResolved.name || nameFromEmail(buyerResolved.email) };

    // --- Title/description shown as "Plan" in your alert ---
    const plan = firstOf(inv, [
      'title','description','memo','subject','lineItems.0.name','lineItems.0.description'
    ], '—');

    // --- Amount & currency (robust across schemas) ---
    let currency = firstOf(inv, [
      'paidAmount.currency','amountPaid.currency',
      'totalAmount.currency','grandTotal.currency','total.currency',
      'amount.currency','amount.value.currency',
      'totals.total.currency',
      'toPay.currency','amountDue.currency'
    ]);
    let amount = firstOf(inv, [
      'paidAmount.amount','amountPaid.amount',
      'totalAmount.amount','grandTotal.amount','total.amount',
      'amount.amount','amount.value',
      'totals.total.amount',
      'toPay.amount','amountDue.amount'
    ]);
    if (amount === undefined) {
      const summed = sumPayments(inv);
      amount = summed.amount ?? amount;
      currency = currency || summed.currency;
    }
    if (amount === undefined) {
      amount = firstOf(event, ['payment.amount.amount','payment.amount.value','payment.amount']);
      currency = currency || firstOf(event, ['payment.amount.currency','payment.currency']);
    }
    currency = currency || inv?.currency || inv?.currencyCode || inv?.totals?.currency;

    await alertPayment({
      source: 'Invoice',
      name: buyer.name,
      email: buyer.email,
      plan,
      amount,
      currency,
      id
    });
  } catch (err) {
    console.error('wixBilling_onInvoicePaid error', err, JSON.stringify(event));
  }
}
