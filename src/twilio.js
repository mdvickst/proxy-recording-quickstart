require('dotenv').config({ quiet: true });
const twilio = require('twilio');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const authHeader = 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

/**
 * Calls a Twilio JSON API with Basic auth.
 * @param {string} method HTTP method.
 * @param {string} url Absolute URL.
 * @param {object} [body] JSON request body.
 * @returns {Promise<{status: number, headers: Headers, body: any}>} Parsed response.
 * @throws {Error} When the response status is not 2xx; message includes the response body.
 */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, headers: res.headers, body: json };
}

/**
 * Returns the item array from a Twilio list response, using `meta.key` / `meta.list_key` when present.
 * @param {object} body List response body.
 * @returns {any[]} List items, or an empty array.
 */
function items(body) {
  const key = body?.meta?.key || body?.meta?.list_key;
  if (key && Array.isArray(body[key])) return body[key];
  return Object.values(body || {}).find(Array.isArray) || [];
}

module.exports = { client, api, items, authHeader };
