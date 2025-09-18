// backend/http-functions.js
import { ok, serverError } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import { fetch } from 'wix-fetch';

// Simple health check so we know routes are registered.
export function get_ping(request) {
  return ok({ pong: true, ts: Date.now() });
}

// Test payment alert to Telegram (no real payment needed)
export async function get_testpayment(request) {
  try {
    const token = await getSecret('TELEGRAM_BOT_TOKEN');
    const chatId = await getSecret('TELEGRAM_CHAT_ID');

    const q = request?.query || {};
    const name = q.name || 'Test Buyer';
    const email = q.email || 'test@example.com';
    const plan = q.plan || 'Test Plan';
    const amount = Number(q.amount ?? 20);
    const currency = q.currency || 'USD';

    const text =
      `<b>✅ Payment received (TEST)</b>\n` +
      `🌐 <b>Site:</b> hts20.net\n` +
      `👤 <b>Name:</b> ${name}\n` +
      `📧 <b>Email:</b> ${email}\n` +
      `🗒️ <b>Plan:</b> ${plan}\n` +
      `💵 <b>Amount:</b> ${amount.toFixed(2)} ${currency}\n` +
      `🧾 <b>ID:</b> TEST-${Date.now()}`;

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });

    return ok({ sent: res.ok });
  } catch (e) {
    console.error('testpayment error', e);
    return serverError(e);
  }
}
