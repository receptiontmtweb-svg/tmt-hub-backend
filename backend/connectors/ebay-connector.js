'use strict';

const Logger = require('../utils/logger');

const EBAY_API_BASE = 'https://api.ebay.com';

function _pickFirst(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}
function _safeStr(e) {
  if (!e) return 'Erreur inconnue';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function _getToken(creds) {
  return _pickFirst(creds.user_token, creds.access_token, creds.token, '');
}

async function _call(path, token, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_FR',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  
  const res = await fetch(`${EBAY_API_BASE}${path}`, opts);
  const text = await res.text();
  
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  
  if (!res.ok) {
    const errMsg = data?.errors?.[0]?.longMessage || data?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data;
}

async function testConnection(creds) {
  try {
    const token = _getToken(creds);
    if (!token) throw new Error('Token eBay manquant');
    const data = await _call('/sell/fulfillment/v1/order?limit=1', token);
    return { ok: true, message: `eBay connecté — ${data.total ?? 0} commande(s)` };
  } catch (e) {
    Logger.error('ebay-connector', 'TEST_FAIL', { err: _safeStr(e) });
    return { ok: false, error: _safeStr(e) };
  }
}

async function getOrders(creds, opts = {}) {
  try {
    const token = _getToken(creds);
    if (!token) throw new Error('Token eBay manquant');
    const limit = opts.limit || 50;
    const data = await _call(`/sell/fulfillment/v1/order?limit=${limit}&orderFulfillmentStatus=NOT_STARTED%7CIN_PROGRESS`, token);
    const orders = (data.orders || []).map(o => normalizeOrder(o)).filter(Boolean);
    return { orders, total: data.total || 0 };
  } catch (e) {
    Logger.error('ebay-connector', 'GET_ORDERS_FAIL', { err: _safeStr(e) });
    throw new Error('eBay getOrders failed: ' + _safeStr(e));
  }
}

async function confirmShipment(creds, payload) {
  try {
    const token = _getToken(creds);
    const { orderId, trackingNumber, carrierCode } = payload;
    await _call(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`, token, 'POST', {
      trackingNumber,
      shippingCarrierCode: carrierCode || 'OTHER',
    });
    return { ok: true, orderId, trackingNumber };
  } catch (e) {
    Logger.error('ebay-connector', 'CONFIRM_SHIPMENT_FAIL', { err: _safeStr(e) });
    throw new Error('eBay confirmShipment failed: ' + _safeStr(e));
  }
}

async function updateStock(creds, sku, quantity) {
  try {
    const token = _getToken(creds);
    await _call(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, token, 'PUT', {
      availability: { shipToLocationAvailability: { quantity } },
    });
    return { ok: true, sku, quantity };
  } catch (e) {
    Logger.error('ebay-connector', 'UPDATE_STOCK_FAIL', { err: _safeStr(e) });
    throw new Error('eBay updateStock failed: ' + _safeStr(e));
  }
}

function normalizeOrder(raw = {}) {
  try {
    const orderId = raw.orderId || raw.id;
    if (!orderId) return null;
    const STATUS_MAP = { NOT_STARTED: 'new', IN_PROGRESS: 'processing', FULFILLED: 'shipped', CANCELLED: 'cancelled' };
    const status = STATUS_MAP[raw.orderFulfillmentStatus] || 'new';
    const shipTo = raw.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
    const items = (raw.lineItems || []).map(i => ({
      lineItemId: i.lineItemId,
      sku: i.sku || '',
      name: i.title || 'Produit eBay',
      qty: i.quantity || 1,
      price: parseFloat(i.lineItemCost?.value || 0),
      total: parseFloat(i.lineItemCost?.value || 0) * (i.quantity || 1),
    }));
    return {
      id: orderId,
      marketplace_id: orderId,
      marketplace: 'ebay',
      status,
      created_at: raw.creationDate || new Date().toISOString(),
      buyer_name: shipTo.fullName || raw.buyer?.username || '',
      buyer_email: '',
      buyer_phone: shipTo.phone || '',
      total: parseFloat(raw.pricingSummary?.total?.value || 0),
      currency: raw.pricingSummary?.total?.currency || 'EUR',
      items,
      shipping: {
        name: shipTo.fullName || '',
        address1: shipTo.contactAddress?.addressLine1 || '',
        city: shipTo.contactAddress?.city || '',
        postal_code: shipTo.contactAddress?.postalCode || '',
        country: shipTo.contactAddress?.countryCode || 'FR',
      },
      raw,
    };
  } catch (e) {
    return null;
  }
}

module.exports = { testConnection, getOrders, confirmShipment, updateStock, normalizeOrder };
