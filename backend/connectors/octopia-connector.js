'use strict';
/**
 * connectors/octopia-connector.js — Cdiscount Octopia API v2
 *
 * Méthodes :
 *   getToken(creds)                        → JWT
 *   testConnection(creds)                  → { ok, message }
 *   getOrders(token, opts)                 → Order[]
 *   getAllOrders(token, opts)              → Order[] (pagination auto)
 *   getOrderDetail(token, orderNumber)     → Order
 *   getOffers(token, opts)                 → Offer[]
 *   upsertOffer(token, offer)              → result
 *   updateStock(token, offers, sellerId)   → { updated, errors }
 *   updatePrices(token, offers, sellerId)  → { updated, errors }
 *   confirmShipment(token, opts)           → { success }
 *   getProducts(token, opts)               → Product[]
 *   createProduct(token, product)          → result
 *   normalizeOrder(raw)                    → TMT order format
 */

const Logger = require('../utils/logger');

const PROD = 'https://api.octopia-io.net/seller';
const SANDBOX = 'https://seller-api.sandbox.octopia.com';

const STATUS_MAP = {
  WaitingForShipmentAcceptation: 'new',
  ShippingConfirmed: 'processing',
  InPreparation: 'new',
  Shipped: 'shipped',
  Cancelled: 'cancelled',
  Refunded: 'cancelled',
  PartiallyShipped: 'processing',
};

const _base = () => (process.env.OCTOPIA_SANDBOX === 'true' ? SANDBOX : PROD);

const _pickSellerId = (src = {}) =>
  src?.sellerId || src?.seller_id || src?.SellerId || null;

const _headers = (token, sellerId) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'TMT-HUB/14.0',
  ...(sellerId ? { SellerId: String(sellerId) } : {}),
});

const _parseErr = (d) => d?.message || d?.error || 'Octopia error';

async function _fetch(url, opts, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        await new Promise((r) =>
          setTimeout(r, (parseInt(res.headers.get('retry-after') || '2', 10) + i) * 1000)
        );
        continue;
      }
      if (res.status >= 500 && i < retries) {
        await new Promise((r) => setTimeout(r, (i + 1) * 1500));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, (i + 1) * 1000));
      }
    }
  }
  throw lastErr || new Error('Octopia: max retries');
}

async function _paginate(token, path, pageSize = 100, sellerId) {
  const all = [];
  let page = 1;

  while (true) {
    const p = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });

    const res = await _fetch(`${_base()}${path}?${p}`, {
      headers: _headers(token, sellerId),
    });

    const d = await res.json();
    if (!res.ok) throw new Error(_parseErr(d));

    const items = Array.isArray(d) ? d : d.items || d.offers || d.orders || d.products || [];
    all.push(...items);

    if (items.length < pageSize) break;
    page++;
    await new Promise((r) => setTimeout(r, 300));
  }

  return all;
}

const OctopiaConnector = {
  _base,
  _headers,

  async testConnection(creds) {
    try {
      const token = await OctopiaConnector.getToken(creds);
      const sellerId = _pickSellerId(creds);

      await OctopiaConnector.getOrders(token, { pageSize: 1, sellerId });

      return {
        ok: true,
        message: 'Connexion Octopia établie',
        sandbox: process.env.OCTOPIA_SANDBOX === 'true',
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  },

  async getToken({ client_id, client_secret }) {
    if (!client_id || !client_secret) {
      throw Object.assign(new Error('Octopia: client_id et client_secret requis'), {
        status: 400,
      });
    }

    const tokenUrl =
      'https://auth.octopia-io.net/auth/realms/maas/protocol/openid-connect/token';

    const res = await _fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'TMT-HUB/14.0',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id,
        client_secret,
      }).toString(),
    });

    const d = await res.json();
    if (!res.ok) throw new Error(_parseErr(d));

    const token = d.access_token || d.token;
    if (!token) throw new Error('Octopia: access_token absent de la réponse');

    Logger.info('octopia', 'TOKEN_OK');
    return token;
  },

  async getOrders(token, opts = {}) {
    const {
      statuses = [],
      page = 1,
      pageSize = 100,
      all = false,
    } = opts;

    const sellerId = _pickSellerId(opts);

    if (!sellerId) {
      throw Object.assign(
        new Error('Octopia: sellerId requis pour /v2/orders'),
        { status: 400 }
      );
    }

    if (all) return _paginate(token, '/v2/orders', pageSize, sellerId);

    const params = {
      page: String(page),
      pageSize: String(pageSize),
    };

    if (statuses && statuses.length > 0) {
      params.states = statuses.join(',');
    }

    const p = new URLSearchParams(params);

    console.log('OCTOPIA_GET_ORDERS sellerId =', sellerId);

    const res = await _fetch(`${_base()}/v2/orders?${p}`, {
      headers: _headers(token, sellerId),
    });

    const rawText = await res.text();
    console.log('OCTOPIA_ORDERS_RAW =', rawText);

    let d;
    try {
      d = rawText ? JSON.parse(rawText) : {};
    } catch {
      d = { raw: rawText };
    }

    if (!res.ok) throw new Error(_parseErr(d));

    if (Array.isArray(d)) return d;
    if (Array.isArray(d.orders)) return d.orders;
    if (Array.isArray(d.Orders)) return d.Orders;
    if (Array.isArray(d.data)) return d.data;
    if (Array.isArray(d.items)) return d.items;
    if (Array.isArray(d.orderList)) return d.orderList;
    if (Array.isArray(d.OrderList)) return d.OrderList;

    return [];
  },

  async getAllOrders(token, opts = {}) {
    const sellerId = _pickSellerId(opts);

    if (!sellerId) {
      throw Object.assign(
        new Error('Octopia: sellerId requis pour /v2/orders'),
        { status: 400 }
      );
    }

    const orders = await _paginate(
      token,
      '/v2/orders',
      opts.pageSize || 100,
      sellerId
    );

    Logger.info('octopia', 'GET_ALL_ORDERS', {
      count: orders.length,
      sellerId,
    });

    return orders;
  },

  async getOrderDetail(token, orderNumber, sellerIdOrOpts) {
    if (!orderNumber) {
      throw Object.assign(new Error('orderNumber requis'), { status: 400 });
    }

    const sellerId =
      typeof sellerIdOrOpts === 'object'
        ? _pickSellerId(sellerIdOrOpts)
        : sellerIdOrOpts;

    if (!sellerId) {
      throw Object.assign(
        new Error('Octopia: sellerId requis pour getOrderDetail'),
        { status: 400 }
      );
    }

    const res = await _fetch(`${_base()}/v2/orders/${orderNumber}`, {
      headers: _headers(token, sellerId),
    });

    const d = await res.json();
    if (!res.ok) throw new Error(_parseErr(d));
    return d;
  },

  async getOffers(token, { page = 1, pageSize = 100, all = false, sellerId } = {}) {
    if (all) return _paginate(token, '/v2/offers', pageSize, sellerId);

    const p = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });

    const res = await _fetch(`${_base()}/v2/offers?${p}`, {
      headers: _headers(token, sellerId),
    });

    const d = await res.json();
    if (!res.ok) throw new Error(_parseErr(d));
    return Array.isArray(d) ? d : d.offers || [];
  },

  async upsertOffer(token, offer, sellerId) {
    if (!offer?.SellerProductId) {
      throw Object.assign(new Error('SellerProductId requis'), { status: 400 });
    }

    const res = await _fetch(`${_base()}/v2/offers`, {
      method: 'POST',
      headers: _headers(token, sellerId),
      body: JSON.stringify({ offer }),
    });

    const d = await res.json();
    if (!res.ok) throw new Error(_parseErr(d));
    return d;
  },

  async updateStock(token, offers, sellerId) {
    if (!Array.isArray(offers) || !offers.length) {
      throw Object.assign(new Error('offers: tableau non vide requis'), { status: 400 });
    }

    const results = { updated: 0, errors: [] };

    for (let i = 0; i < offers.length; i += 1000) {
      const batch = offers.slice(i, i + 1000);

      const res = await _fetch(`${_base()}/v2/offers/stock`, {
        method: 'PUT',
        headers: _headers(token, sellerId),
        body: JSON.stringify({ offers: batch }),
      });

      if (res.status === 204) {
        results.updated += batch.length;
        continue;
      }

      const d = await res.json();
      if (!res.ok) {
        results.errors.push({ batch: Math.floor(i / 1000), error: _parseErr(d) });
      } else {
        results.updated += batch.length;
      }

      if (i + 1000 < offers.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    Logger.info('octopia', 'UPDATE_STOCK', {
      updated: results.updated,
      errors: results.errors.length,
    });

    return results;
  },

  async updatePrices(token, offers, sellerId) {
    if (!Array.isArray(offers) || !offers.length) {
      throw Object.assign(new Error('offers: tableau non vide requis'), { status: 400 });
    }

    const results = { updated: 0, errors: [] };

    for (let i = 0; i < offers.length; i += 1000) {
      const batch = offers.slice(i, i + 1000);

      const res = await _fetch(`${_base()}/v2/offers/price`, {
        method: 'PUT',
        headers: _headers(token, sellerId),
        body: JSON.stringify({ offers: batch }),
      });

      if (res.status === 204) {
        results.updated += batch.length;
        continue;
      }

      const d = await res.json();
      if (!res.ok) {
        results.errors.push({ batch: Math.floor(i / 1000), error: _parseErr(d) });
      } else {
        results.updated += batch.length;
      }
    }

    Logger.info('octopia', 'UPDATE_PRICES', { updated: results.updated });
    return results;
  },

  async confirmShipment(
    token,
    { orderNumber, trackingNumber, carrierName = 'Colissimo', trackingUrl, sellerId }
  ) {
    if (!orderNumber || !trackingNumber) {
      throw Object.assign(new Error('orderNumber et trackingNumber requis'), { status: 400 });
    }

    const res = await _fetch(`${_base()}/v2/orders/${orderNumber}/shipping`, {
      method: 'POST',
      headers: _headers(token, sellerId),
      body: JSON.stringify({
        carrier_name: carrierName,
        tracking_number: trackingNumber,
        tracking_url:
          trackingUrl ||
          `https://www.laposte.fr/outils/suivre-vos-envois?code=${trackingNumber}`,
      }),
    });

    if (res.status === 204 || res.status === 200) {
      Logger.info('octopia', 'CONFIRM_SHIP', { orderNumber, trackingNumber });
      return { success: true };
    }

    const d = await res.json();
    if (!res.ok) throw new Error(_parseErr(d));
    return { success: true };
  },

  async getProducts(token, { page = 1, pageSize = 100, all = false, sellerId } = {}) {
    if (all) return _paginate(token, '/v2/products', pageSize, sellerId);

    const p = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });

    const res = await _fetch(`${_base()}/v2/products?${p}`, {
      headers: _headers(token, sellerId),
    });

    const d = await res.json();
    if (!res.ok) throw new Error(_parseErr(d));
    return Array.isArray(d) ? d : d.products || [];
  },

  async createProduct(token, product, sellerId) {
    if (!product?.EAN && !product?.SellerProductId) {
      throw Object.assign(new Error('EAN ou SellerProductId requis'), { status: 400 });
    }

    const res = await _fetch(`${_base()}/v2/products`, {
      method: 'POST',
      headers: _headers(token, sellerId),
      body: JSON.stringify({ product }),
    });

    const d = await res.json();
    if (!res.ok) throw new Error(_parseErr(d));
    return d;
  },

  normalizeOrder(o) {
    const lines = Array.isArray(o?.lines) ? o.lines : Array.isArray(o?.Lines) ? o.Lines : [];
    const line0 = lines[0] || {};

    const shipping = line0?.shippingAddress || {};
    const billing = o?.billingAddress || {};

    const totalSelling =
      typeof o?.totalPrice?.sellingPrice === 'number'
        ? o.totalPrice.sellingPrice
        : typeof o?.totalPrice?.offerPrice === 'number'
        ? o.totalPrice.offerPrice
        : parseFloat(o.TotalAmount || o.totalAmount || 0);

    const deliveryMode =
      line0?.delivery?.mode ||
      o?.delivery?.mode ||
      o?.shippingMode ||
      o?.deliveryMode ||
      '';

    return {
      marketplace_id: String(
        o.orderId ||
        o.reference ||
        o.OrderNumber ||
        o.orderNumber ||
        ''
      ),
      marketplace: 'cdiscount',

      buyer_name:
        [
          shipping.firstName || billing.firstName,
          shipping.lastName || billing.lastName,
        ].filter(Boolean).join(' ') ||
        o?.customer?.reference ||
        '',

      buyer_email:
        shipping.email ||
        billing.email ||
        o?.customer?.email ||
        '',

      address:
        shipping.addressLine1 ||
        billing.addressLine1 ||
        '',

      postal_code:
        shipping.postalCode ||
        billing.postalCode ||
        '',

      city:
        shipping.city ||
        billing.city ||
        '',

      country:
        shipping.countryCode ||
        billing.countryCode ||
        'FR',

      phone:
        shipping.phone ||
        '',

      total: parseFloat(totalSelling || 0),
      currency: o.currencyCode || 'EUR',
      status: STATUS_MAP[o.status || o.State || o.state] || 'new',
      delivery_mode: deliveryMode,
      is_mondial_relay: /relay|pickup|mondial/i.test(deliveryMode),
      raw: o,

      items: lines.map((l) => ({
        sku:
          l?.offer?.sellerProductId ||
          l?.SellerProductId ||
          l?.sellerProductId ||
          '',
        ean:
          l?.offer?.productGtin ||
          l?.ProductEan ||
          l?.productEan ||
          '',
        title:
          l?.offer?.productTitle ||
          l?.ProductTitle ||
          l?.productTitle ||
          'Produit',
        quantity: l.quantity || l.Quantity || 1,
        price: parseFloat(
          l?.sellingPrice?.unitSalesPrice ??
          l?.totalPrice?.sellingPrice ??
          l?.Price ??
          l?.price ??
          0
        ),
      })),
    };
  },
};

module.exports = OctopiaConnector;