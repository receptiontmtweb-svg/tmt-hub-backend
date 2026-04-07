'use strict';

const Logger = require('../utils/logger');

const EBAY_API_BASE = 'https://api.ebay.com';
const EBAY_FR_SITE  = 'EBAY_FR';

// ── helpers ──────────────────────────────────────────────────
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
async function _fetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`eBay HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = res.status;
    err.data   = data;
    throw err;
  }
  return data;
}

// ── Auth headers ─────────────────────────────────────────────
function _authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'X-EBAY-C-MARKETPLACE-ID': EBAY_FR_SITE,
  };
}

// =====================================================================
// TEST CONNEXION
// =====================================================================
async function testConnection(creds) {
  try {
    const token = _pickFirst(creds.user_token, creds.access_token, creds.token, '');
    if (!token) throw new Error('Token eBay manquant');

    const data = await _fetch(`${EBAY_API_BASE}/sell/fulfillment/v1/order?limit=1`, {
      headers: _authHeaders(token),
    });

    return {
      ok:      true,
      message: `eBay connecté — ${data.total ?? '?'} commande(s) totale(s)`,
      total:   data.total ?? 0,
    };
  } catch (e) {
    Logger.error('ebay-connector', 'TEST_FAIL', { err: _safeStr(e) });
    return { ok: false, error: _safeStr(e) };
  }
}

// =====================================================================
// GET ORDERS
// =====================================================================
async function getOrders(creds, opts = {}) {
  try {
    const token = _pickFirst(creds.user_token, creds.access_token, creds.token, '');
    if (!token) throw new Error('Token eBay manquant');

    const limit  = opts.limit || 50;
    const filter = opts.filter || 'orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}';

    const params = new URLSearchParams({ limit, filter });
    if (opts.offset) params.set('offset', opts.offset);

    const data = await _fetch(
      `${EBAY_API_BASE}/sell/fulfillment/v1/order?${params}`,
      { headers: _authHeaders(token) }
    );

    const orders = (data.orders || []).map(o => normalizeOrder(o));
    Logger.info('ebay-connector', 'GET_ORDERS_OK', { count: orders.length });
    return { orders, total: data.total || 0, next: data.next || null };
  } catch (e) {
    Logger.error('ebay-connector', 'GET_ORDERS_FAIL', { err: _safeStr(e) });
    throw new Error('eBay getOrders failed: ' + _safeStr(e));
  }
}

// =====================================================================
// GET ORDER DETAIL
// =====================================================================
async function getOrder(creds, orderId) {
  try {
    const token = _pickFirst(creds.user_token, creds.access_token, creds.token, '');
    const data  = await _fetch(
      `${EBAY_API_BASE}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`,
      { headers: _authHeaders(token) }
    );
    return normalizeOrder(data);
  } catch (e) {
    Logger.error('ebay-connector', 'GET_ORDER_FAIL', { orderId, err: _safeStr(e) });
    throw new Error('eBay getOrder failed: ' + _safeStr(e));
  }
}

// =====================================================================
// CONFIRM SHIPMENT
// =====================================================================
async function confirmShipment(creds, payload) {
  try {
    const token = _pickFirst(creds.user_token, creds.access_token, creds.token, '');
    const { orderId, trackingNumber, carrierCode, lineItems = [] } = payload;

    const body = {
      trackingNumber,
      shippingCarrierCode: carrierCode || 'OTHER',
      lineItems: lineItems.length
        ? lineItems.map(i => ({ lineItemId: i.lineItemId, quantity: i.quantity || 1 }))
        : undefined,
    };

    await _fetch(
      `${EBAY_API_BASE}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`,
      {
        method:  'POST',
        headers: _authHeaders(token),
        body:    JSON.stringify(body),
      }
    );

    Logger.info('ebay-connector', 'CONFIRM_SHIPMENT_OK', { orderId, trackingNumber });
    return { ok: true, orderId, trackingNumber };
  } catch (e) {
    Logger.error('ebay-connector', 'CONFIRM_SHIPMENT_FAIL', { err: _safeStr(e) });
    throw new Error('eBay confirmShipment failed: ' + _safeStr(e));
  }
}

// =====================================================================
// UPDATE STOCK (Inventory API)
// =====================================================================
async function updateStock(creds, sku, quantity) {
  try {
    const token = _pickFirst(creds.user_token, creds.access_token, creds.token, '');

    await _fetch(
      `${EBAY_API_BASE}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      {
        method:  'PUT',
        headers: _authHeaders(token),
        body:    JSON.stringify({
          availability: {
            shipToLocationAvailability: { quantity },
          },
        }),
      }
    );

    Logger.info('ebay-connector', 'UPDATE_STOCK_OK', { sku, quantity });
    return { ok: true, sku, quantity };
  } catch (e) {
    Logger.error('ebay-connector', 'UPDATE_STOCK_FAIL', { sku, err: _safeStr(e) });
    throw new Error('eBay updateStock failed: ' + _safeStr(e));
  }
}

// =====================================================================
// CREATE / UPDATE LISTING (Inventory API)
// =====================================================================
async function upsertListing(creds, product) {
  try {
    const token = _pickFirst(creds.user_token, creds.access_token, creds.token, '');
    const sku   = product.sku || product.SKU;
    if (!sku) throw new Error('SKU requis pour créer une annonce eBay');

    // 1. Créer/mettre à jour l'inventory item
    await _fetch(
      `${EBAY_API_BASE}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      {
        method:  'PUT',
        headers: _authHeaders(token),
        body:    JSON.stringify({
          product: {
            title:       product.title || product.name,
            description: product.description || '',
            ean:         product.ean ? [product.ean] : undefined,
            imageUrls:   product.images || product.imageUrls || [],
          },
          availability: {
            shipToLocationAvailability: { quantity: product.quantity || product.stock || 1 },
          },
          condition: product.condition || 'NEW',
        }),
      }
    );

    Logger.info('ebay-connector', 'UPSERT_LISTING_OK', { sku });
    return { ok: true, sku, message: 'Inventory item créé/mis à jour' };
  } catch (e) {
    Logger.error('ebay-connector', 'UPSERT_LISTING_FAIL', { err: _safeStr(e) });
    throw new Error('eBay upsertListing failed: ' + _safeStr(e));
  }
}

// =====================================================================
// NORMALIZE ORDER
// =====================================================================
function normalizeOrder(raw = {}) {
  try {
    const orderId = _pickFirst(raw.orderId, raw.id, '');
    if (!orderId) return null;

    const STATUS_MAP = {
      NOT_STARTED:  'new',
      IN_PROGRESS:  'processing',
      FULFILLED:    'shipped',
      CANCELLED:    'cancelled',
    };

    const statusRaw = _pickFirst(raw.orderFulfillmentStatus, raw.status, 'NOT_STARTED');
    const status    = STATUS_MAP[statusRaw] || 'new';
    const created_at = _pickFirst(raw.creationDate, raw.created_at, new Date().toISOString());

    const buyer_name  = _pickFirst(
      raw.buyer?.username,
      raw.shippingAddress?.fullName,
      raw.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName,
      ''
    );
    const buyer_email = _pickFirst(raw.buyer?.buyerRegistrationAddress?.email, '');

    const shipTo = raw.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};

    const items = (raw.lineItems || []).map(i => ({
      lineItemId: i.lineItemId,
      sku:        _pickFirst(i.sku, ''),
      name:       _pickFirst(i.title, 'Produit eBay'),
      title:      _pickFirst(i.title, 'Produit eBay'),
      qty:        i.quantity || 1,
      quantity:   i.quantity || 1,
      price:      parseFloat(i.lineItemCost?.value || 0),
      total:      parseFloat(i.lineItemCost?.value || 0) * (i.quantity || 1),
      ean:        '',
    }));

    const total_amount = parseFloat(raw.pricingSummary?.total?.value || 0);
    const currency     = _pickFirst(raw.pricingSummary?.total?.currency, 'EUR');

    return {
      id:             orderId,
      marketplace_id: orderId,
      marketplace:    'ebay',
      status,
      created_at,
      buyer_name,
      buyer_email,
      buyer_phone:    _pickFirst(shipTo.phone, ''),
      total:          total_amount,
      total_amount,
      currency,
      items,
      lines:          items,
      shipping: {
        name:        _pickFirst(shipTo.fullName, buyer_name),
        address1:    _pickFirst(shipTo.contactAddress?.addressLine1, ''),
        address2:    _pickFirst(shipTo.contactAddress?.addressLine2, ''),
        city:        _pickFirst(shipTo.contactAddress?.city, ''),
        postal_code: _pickFirst(shipTo.contactAddress?.postalCode, ''),
        country:     _pickFirst(shipTo.contactAddress?.countryCode, 'FR'),
      },
      raw,
    };
  } catch (e) {
    Logger.error('ebay-connector', 'NORMALIZE_FAIL', { err: _safeStr(e) });
    return null;
  }
}

module.exports = {
  testConnection,
  getOrders,
  getOrder,
  confirmShipment,
  updateStock,
  upsertListing,
  normalizeOrder,
};
