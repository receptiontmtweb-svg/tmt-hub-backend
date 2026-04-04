'use strict';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const axios  = require('axios');
const qs     = require('querystring');
const Logger = require('../utils/logger');

const SP_API_BASE = 'https://sellingpartnerapi-eu.amazon.com';
const DEFAULT_MP  = 'A13V1IB3VIYZZH'; // France

// ── helpers internes ──────────────────────────────────────────────

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

function _axErr(e) {
  const d = e?.response?.data;
  if (d) {
    try { return typeof d === 'string' ? d.slice(0, 500) : JSON.stringify(d).slice(0, 500); }
    catch { return String(d).slice(0, 500); }
  }
  return _safeStr(e);
}

// =====================================================================
// TOKEN AMAZON (LWA)
// =====================================================================
async function getToken(creds) {
  try {
    const res = await axios.post(
      'https://api.amazon.com/auth/o2/token',
      qs.stringify({
        grant_type:    'refresh_token',
        refresh_token: creds.refresh_token,
        client_id:     creds.client_id,
        client_secret: creds.client_secret,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = res?.data?.access_token;
    if (!accessToken) {
      throw new Error('Token Amazon manquant dans la réponse LWA');
    }

    return accessToken;
  } catch (e) {
    Logger.error('amazon-connector', 'GET_TOKEN_FAIL', { err: _axErr(e) });
    throw new Error('Erreur récupération token Amazon : ' + _axErr(e));
  }
}

// =====================================================================
// TEST CONNEXION
// =====================================================================
async function testConnection(creds) {
  try {
    const token = await getToken(creds);
    return {
      ok: !!token,
      token_preview: token ? String(token).slice(0, 20) + '...' : ''
    };
  } catch (e) {
    return { ok: false, error: _safeStr(e) };
  }
}

// =====================================================================
// GET ORDERS (simple)
// =====================================================================
async function getOrders(token, opts = {}) {
  try {
    const marketplaceId =
      opts.marketplaceId ||
      opts.MarketplaceIds ||
      DEFAULT_MP;

    const createdAfter =
      opts.createdAfter ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const params = {
      MarketplaceIds: Array.isArray(marketplaceId) ? marketplaceId.join(',') : marketplaceId,
      CreatedAfter: createdAfter,
    };

    if (opts.OrderStatuses)       params.OrderStatuses = opts.OrderStatuses;
    if (opts.FulfillmentChannels) params.FulfillmentChannels = opts.FulfillmentChannels;
    if (opts.NextToken)           params.NextToken = opts.NextToken;

    Logger.info('amazon-connector', 'GET_ORDERS_START', {
      marketplaceId: params.MarketplaceIds,
      createdAfter,
      hasNextToken: !!opts.NextToken,
    });

    const res = await axios.get(
      `${SP_API_BASE}/orders/v0/orders`,
      {
        headers: { 'x-amz-access-token': token },
        params,
      }
    );

    const payload = res?.data?.payload || res?.data || {};
    const orders  = payload?.Orders || payload?.orders || [];

    Logger.info('amazon-connector', 'GET_ORDERS_OK', {
      count: orders.length,
      hasNextToken: !!payload?.NextToken,
    });

    return orders;
  } catch (e) {
    Logger.error('amazon-connector', 'GET_ORDERS_FAIL', {
      status: e?.response?.status,
      err: _axErr(e),
    });
    throw new Error('Amazon getOrders failed: ' + _axErr(e));
  }
}

// =====================================================================
// GET ALL ORDERS — pagination automatique via NextToken
// =====================================================================
async function getAllOrders(token, opts = {}) {
  const allOrders = [];
  let nextToken   = null;
  let page        = 0;
  const maxPages  = opts.maxPages || 10;

  do {
    try {
      const marketplaceId = opts.marketplaceId || opts.MarketplaceIds || DEFAULT_MP;
      const params = {
        MarketplaceIds: Array.isArray(marketplaceId) ? marketplaceId.join(',') : marketplaceId,
      };

      if (!nextToken) {
        params.CreatedAfter =
          opts.createdAfter ||
          new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      }

      if (nextToken)                params.NextToken = nextToken;
      if (opts.OrderStatuses)       params.OrderStatuses = opts.OrderStatuses;
      if (opts.FulfillmentChannels) params.FulfillmentChannels = opts.FulfillmentChannels;

      const res = await axios.get(
        `${SP_API_BASE}/orders/v0/orders`,
        {
          headers: { 'x-amz-access-token': token },
          params,
        }
      );

      const payload = res?.data?.payload || res?.data || {};
      const batch   = payload?.Orders || payload?.orders || [];

      allOrders.push(...batch);
      nextToken = payload?.NextToken || null;
      page++;

      if (page < maxPages && nextToken) {
        await sleep(500);
      }
    } catch (e) {
      Logger.error('amazon-connector', 'GET_ALL_ORDERS_PAGE_FAIL', {
        page,
        status: e?.response?.status,
        err: _axErr(e),
      });
      break;
    }
  } while (nextToken && page < maxPages);

  return allOrders;
}

// =====================================================================
// GET ORDER — détail buyer + adresse (enrichi via endpoints dédiés)
// =====================================================================
async function getOrder(token, orderId, retryCount = 0) {
  try {
    await sleep(800);

    const res = await axios.get(
      `${SP_API_BASE}/orders/v0/orders/${encodeURIComponent(orderId)}`,
      { headers: { 'x-amz-access-token': token } }
    );

    const payload = res?.data?.payload || res?.data || {};
    const order   = { ...(payload || {}) };

    if (!order.AmazonOrderId   && order.amazonOrderId)    order.AmazonOrderId = order.amazonOrderId;
    if (!order.OrderStatus     && order.orderStatus)      order.OrderStatus = order.orderStatus;
    if (!order.PurchaseDate    && order.purchaseDate)     order.PurchaseDate = order.purchaseDate;
    if (!order.BuyerInfo       && order.buyerInfo)        order.BuyerInfo = order.buyerInfo;
    if (!order.ShippingAddress && order.shippingAddress)  order.ShippingAddress = order.shippingAddress;

    // ── Enrichissement BuyerInfo via endpoint dédié /buyerInfo ──────
    // On tente l'appel même si BuyerInfo existe déjà, pour récupérer
    // des champs supplémentaires (BuyerEmail, BuyerTaxInfo, etc.)
    try {
      const buyerInfoData = await getOrderBuyerInfo(token, orderId);
      if (buyerInfoData && typeof buyerInfoData === 'object') {
        const fetchedBuyerName  = _pickFirst(
          buyerInfoData.BuyerName,
          buyerInfoData.buyerName,
          ''
        );
        const fetchedBuyerEmail = _pickFirst(
          buyerInfoData.BuyerEmail,
          buyerInfoData.buyerEmail,
          ''
        );
        // Fusion : priorité aux données du endpoint dédié
        order.BuyerInfo = {
          ...(order.BuyerInfo || {}),
          ...buyerInfoData,
          BuyerName:  fetchedBuyerName  || order.BuyerInfo?.BuyerName  || '',
          BuyerEmail: fetchedBuyerEmail || order.BuyerInfo?.BuyerEmail || '',
        };
        Logger.info('amazon-connector', 'GET_ORDER_BUYER_MERGED', {
          orderId,
          hasBuyerName:  !!order.BuyerInfo.BuyerName,
          hasBuyerEmail: !!order.BuyerInfo.BuyerEmail,
        });
      }
    } catch (buyerErr) {
      Logger.warn('amazon-connector', 'GET_ORDER_BUYER_INFO_SKIP', {
        orderId,
        err: _safeStr(buyerErr),
      });
    }

    // ── Enrichissement ShippingAddress via endpoint dédié /address ──
    // On tente l'appel même si ShippingAddress existe déjà, pour
    // récupérer Phone et les champs complets d'adresse
    try {
      const addressData = await getOrderAddress(token, orderId);
      if (addressData && typeof addressData === 'object' && Object.keys(addressData).length > 0) {
        const fetchedPhone = _pickFirst(
          addressData.Phone,
          addressData.phone,
          ''
        );
        // Fusion : on prend le meilleur des deux sources
        order.ShippingAddress = {
          Name:          _pickFirst(addressData.Name, addressData.name, order.ShippingAddress?.Name, ''),
          AddressLine1:  _pickFirst(addressData.AddressLine1, addressData.addressLine1, order.ShippingAddress?.AddressLine1, ''),
          AddressLine2:  _pickFirst(addressData.AddressLine2, addressData.addressLine2, order.ShippingAddress?.AddressLine2, ''),
          AddressLine3:  _pickFirst(addressData.AddressLine3, addressData.addressLine3, order.ShippingAddress?.AddressLine3, ''),
          City:          _pickFirst(addressData.City, addressData.city, order.ShippingAddress?.City, ''),
          PostalCode:    _pickFirst(addressData.PostalCode, addressData.postalCode, order.ShippingAddress?.PostalCode, ''),
          StateOrRegion: _pickFirst(addressData.StateOrRegion, addressData.stateOrRegion, order.ShippingAddress?.StateOrRegion, ''),
          CountryCode:   _pickFirst(addressData.CountryCode, addressData.countryCode, order.ShippingAddress?.CountryCode, 'FR'),
          Phone:         fetchedPhone || order.ShippingAddress?.Phone || '',
        };
        Logger.info('amazon-connector', 'GET_ORDER_ADDRESS_MERGED', {
          orderId,
          hasName:  !!order.ShippingAddress.Name,
          hasPhone: !!order.ShippingAddress.Phone,
          city:     order.ShippingAddress.City,
        });
      }
    } catch (addrErr) {
      Logger.warn('amazon-connector', 'GET_ORDER_ADDRESS_SKIP', {
        orderId,
        err: _safeStr(addrErr),
      });
    }

    // ── Fallback interne si BuyerInfo toujours absent ────────────────
    if (!order.BuyerInfo && (order.buyer?.buyerEmail || order.buyer?.buyerName)) {
      order.BuyerInfo = {
        BuyerName:  order.buyer?.buyerName  || '',
        BuyerEmail: order.buyer?.buyerEmail || '',
      };
    }

    // ── Fallback interne si ShippingAddress toujours absent ──────────
    if (!order.ShippingAddress && order.recipient?.deliveryAddress) {
      const a = order.recipient.deliveryAddress;
      order.ShippingAddress = {
        Name:          _pickFirst(order.buyer?.buyerName, a.name, ''),
        AddressLine1:  a.addressLine1  || '',
        AddressLine2:  a.addressLine2  || '',
        AddressLine3:  a.addressLine3  || '',
        City:          a.city          || '',
        PostalCode:    a.postalCode    || '',
        StateOrRegion: a.stateOrRegion || '',
        CountryCode:   a.countryCode   || 'FR',
        Phone:         a.phone         || '',
      };
    }

    return order;
  } catch (e) {
    const status = e?.response?.status;

    if (status === 429 && retryCount < 2) {
      Logger.warn('amazon-connector', 'GET_ORDER_RETRY_429', { orderId, retryCount });
      await sleep(3000);
      return getOrder(token, orderId, retryCount + 1);
    }

    Logger.error('amazon-connector', 'GET_ORDER_FAIL', {
      orderId,
      status,
      err: _axErr(e),
    });
    throw new Error('Amazon getOrder failed (' + orderId + '): ' + _axErr(e));
  }
}

// =====================================================================
// GET ORDER ITEMS
// =====================================================================
async function getOrderItems(token, orderId, retryCount = 0) {
  try {
    await sleep(800);

    const res = await axios.get(
      `${SP_API_BASE}/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
      {
        headers: { 'x-amz-access-token': token }
      }
    );

    return res?.data?.payload?.OrderItems || [];
  } catch (e) {
    const status = e?.response?.status;

    if (status === 429 && retryCount < 2) {
      Logger.warn('amazon-connector', 'GET_ORDER_ITEMS_RETRY_429', { orderId, retryCount });
      await sleep(3000);
      return getOrderItems(token, orderId, retryCount + 1);
    }

    Logger.error('amazon-connector', 'GET_ORDER_ITEMS_FAIL', {
      orderId,
      status,
      err: _axErr(e),
    });

    return [];
  }
}

// =====================================================================
// GET ORDER BUYER INFO — endpoint dédié /buyerInfo
// =====================================================================
async function getOrderBuyerInfo(token, orderId, retryCount = 0) {
  try {
    await sleep(400);

    const res = await axios.get(
      `${SP_API_BASE}/orders/v0/orders/${encodeURIComponent(orderId)}/buyerInfo`,
      { headers: { 'x-amz-access-token': token } }
    );

    const payload = res?.data?.payload || res?.data || {};

    Logger.info('amazon-connector', 'AMZ_BUYER_INFO', {
      orderId,
      hasBuyerName:  !!(payload.BuyerName  || payload.buyerName),
      hasBuyerEmail: !!(payload.BuyerEmail || payload.buyerEmail),
    });

    return payload;
  } catch (e) {
    const status = e?.response?.status;

    if (status === 429 && retryCount < 3) {
      const delay = 2000 * (retryCount + 1);
      Logger.warn('amazon-connector', 'AMZ_BUYER_INFO_RETRY_429', { orderId, retryCount, delay });
      await sleep(delay);
      return getOrderBuyerInfo(token, orderId, retryCount + 1);
    }

    // 403 = pas de permission PII, on log en warn (non bloquant)
    if (status === 403) {
      Logger.warn('amazon-connector', 'AMZ_BUYER_INFO_FORBIDDEN', {
        orderId,
        note: 'Permissions PII insuffisantes pour cet endpoint',
      });
      return {};
    }

    Logger.error('amazon-connector', 'AMZ_BUYER_INFO_FAIL', {
      orderId,
      status,
      err: _axErr(e),
    });
    return {}; // non bloquant : on retourne objet vide
  }
}

// =====================================================================
// GET ORDER ADDRESS — endpoint dédié /address
// =====================================================================
async function getOrderAddress(token, orderId, retryCount = 0) {
  try {
    await sleep(400);

    const res = await axios.get(
      `${SP_API_BASE}/orders/v0/orders/${encodeURIComponent(orderId)}/address`,
      { headers: { 'x-amz-access-token': token } }
    );

    const payload = res?.data?.payload || res?.data || {};
    const addr    = payload.ShippingAddress || payload.shippingAddress || payload || {};

    Logger.info('amazon-connector', 'AMZ_ADDRESS', {
      orderId,
      hasName:  !!(addr.Name  || addr.name),
      hasPhone: !!(addr.Phone || addr.phone),
      city:     addr.City || addr.city || '',
    });

    return addr;
  } catch (e) {
    const status = e?.response?.status;

    if (status === 429 && retryCount < 3) {
      const delay = 2000 * (retryCount + 1);
      Logger.warn('amazon-connector', 'AMZ_ADDRESS_RETRY_429', { orderId, retryCount, delay });
      await sleep(delay);
      return getOrderAddress(token, orderId, retryCount + 1);
    }

    if (status === 403) {
      Logger.warn('amazon-connector', 'AMZ_ADDRESS_FORBIDDEN', {
        orderId,
        note: 'Permissions PII insuffisantes pour cet endpoint',
      });
      return {};
    }

    Logger.error('amazon-connector', 'AMZ_ADDRESS_FAIL', {
      orderId,
      status,
      err: _axErr(e),
    });
    return {}; // non bloquant
  }
}

// =====================================================================
// CONFIRM SHIPMENT
// =====================================================================
async function confirmShipment(token, payload) {
  try {
    const { orderId, items = [], trackingNumber, carrierCode } = payload;

    const body = {
      marketplaceId: payload.marketplaceId || DEFAULT_MP,
      shippingDetails: {
        trackingNumber,
        carrierCode: carrierCode || 'Other',
        carrierName: payload.carrierName || carrierCode || '',
        shippingDate: payload.shippingDate || new Date().toISOString(),
      },
      orderItems: items.map(i => ({
        orderItemId: i.orderItemId || i.OrderItemId,
        quantity:    i.quantity || i.qty || 1,
      })),
    };

    await axios.post(
      `${SP_API_BASE}/orders/v0/orders/${encodeURIComponent(orderId)}/shipment`,
      body,
      {
        headers: {
          'x-amz-access-token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    return { ok: true, orderId, trackingNumber };
  } catch (e) {
    Logger.error('amazon-connector', 'CONFIRM_SHIPMENT_FAIL', { err: _axErr(e) });
    throw new Error('Amazon confirmShipment failed: ' + _axErr(e));
  }
}

// =====================================================================
// GET INVENTORY
// =====================================================================
async function getInventory(token, opts = {}) {
  try {
    const mpId = opts.marketplaceId || DEFAULT_MP;
    const res = await axios.get(
      `${SP_API_BASE}/fba/inventory/v1/summaries`,
      {
        headers: { 'x-amz-access-token': token },
        params: {
          granularityType: 'Marketplace',
          granularityId: mpId,
          marketplaceIds: mpId
        },
      }
    );
    return res?.data?.payload || res?.data || {};
  } catch (e) {
    Logger.error('amazon-connector', 'GET_INVENTORY_FAIL', { err: _axErr(e) });
    throw new Error('Amazon getInventory failed: ' + _axErr(e));
  }
}

// =====================================================================
// UPDATE STOCK
// =====================================================================
async function updateStock(token, sellerId, sku, quantity, mpId) {
  try {
    return {
      ok: true,
      sku,
      quantity,
      note: 'Stock update via Feeds API — à brancher si nécessaire'
    };
  } catch (e) {
    Logger.error('amazon-connector', 'UPDATE_STOCK_FAIL', { err: _axErr(e) });
    throw new Error('Amazon updateStock failed: ' + _axErr(e));
  }
}

// =====================================================================
// UPDATE PRICE
// =====================================================================
async function updatePrice(token, sellerId, sku, price, mpId) {
  try {
    return {
      ok: true,
      sku,
      price,
      note: 'Price update via Feeds API — à brancher si nécessaire'
    };
  } catch (e) {
    Logger.error('amazon-connector', 'UPDATE_PRICE_FAIL', { err: _axErr(e) });
    throw new Error('Amazon updatePrice failed: ' + _axErr(e));
  }
}

// =====================================================================
// REQUEST REPORT
// =====================================================================
async function requestReport(token, reportType, mpId) {
  try {
    const res = await axios.post(
      `${SP_API_BASE}/reports/2021-06-30/reports`,
      {
        reportType: reportType || 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
        marketplaceIds: [mpId || DEFAULT_MP],
      },
      {
        headers: {
          'x-amz-access-token': token,
          'Content-Type': 'application/json'
        }
      }
    );
    return res?.data || {};
  } catch (e) {
    Logger.error('amazon-connector', 'REQUEST_REPORT_FAIL', { err: _axErr(e) });
    throw new Error('Amazon requestReport failed: ' + _axErr(e));
  }
}

// =====================================================================
// GET CATALOG ITEM
// =====================================================================
async function getCatalogItem(token, opts = {}) {
  try {
    const res = await axios.get(
      `${SP_API_BASE}/catalog/2022-04-01/items/${encodeURIComponent(opts.asin || '')}`,
      {
        headers: { 'x-amz-access-token': token },
        params: { marketplaceIds: opts.marketplaceId || DEFAULT_MP },
      }
    );
    return res?.data || {};
  } catch (e) {
    Logger.error('amazon-connector', 'GET_CATALOG_ITEM_FAIL', { err: _axErr(e) });
    throw new Error('Amazon getCatalogItem failed: ' + _axErr(e));
  }
}

// =====================================================================
// NORMALIZE ORDER
// =====================================================================
function normalizeOrder(raw = {}, orderItems = []) {
  try {
    const orderId = _pickFirst(
      raw.AmazonOrderId,
      raw.amazonOrderId,
      raw.orderId,
      raw.id,
      ''
    );

    if (!orderId) {
      Logger.warn('amazon-connector', 'NORMALIZE_NO_ID', {
        keys: Object.keys(raw).slice(0, 15).join(', '),
      });
      return null;
    }

    const statusRaw = _pickFirst(
      raw.OrderStatus,
      raw.orderStatus,
      raw.status,
      'Unshipped'
    );

    const STATUS_MAP = {
      Pending:             'new',
      PendingAvailability: 'new',
      Unshipped:           'new',
      PartiallyShipped:    'processing',
      Shipped:             'shipped',
      InvoiceUnconfirmed:  'processing',
      Canceled:            'cancelled',
      Unfulfillable:       'cancelled',
    };

    const status = STATUS_MAP[statusRaw] || String(statusRaw).toLowerCase();

    const created_at = _pickFirst(
      raw.PurchaseDate,
      raw.purchaseDate,
      raw.createdTime,
      raw.createdAt,
      raw.created_at,
      new Date().toISOString()
    );

    const buyer_name = _pickFirst(
      raw.BuyerInfo?.BuyerName,
      raw.buyerInfo?.buyerName,
      raw.buyer?.buyerName,
      raw.buyer?.name,
      raw.BuyerName,
      raw.buyerName,
      raw.ShippingAddress?.Name,
      raw.shippingAddress?.Name,
      raw.recipient?.deliveryAddress?.name,
      raw.shipping_name,
      ''
    );

    const buyer_email = _pickFirst(
      raw.BuyerInfo?.BuyerEmail,
      raw.buyerInfo?.buyerEmail,
      raw.buyer?.buyerEmail,
      raw.buyer?.email,
      raw.BuyerEmail,
      raw.buyerEmail,
      ''
    );

    // ── buyer_phone : priorité ShippingAddress.Phone (données PII endpoint /address) ──
    const buyer_phone = _pickFirst(
      raw.ShippingAddress?.Phone,
      raw.shippingAddress?.Phone,
      raw.ShippingAddress?.phone,
      raw.shippingAddress?.phone,
      raw.BuyerInfo?.Phone,
      raw.buyerInfo?.phone,
      raw.buyer?.phone,
      raw.recipient?.deliveryAddress?.phone,
      ''
    );

    const total_amount = parseFloat(
      _pickFirst(
        raw.OrderTotal?.Amount,
        raw.orderTotal?.amount,
        raw.total,
        raw.amount,
        0
      )
    ) || 0;

    const currency = _pickFirst(
      raw.OrderTotal?.CurrencyCode,
      raw.orderTotal?.currencyCode,
      raw.currency,
      'EUR'
    );

    const itemsSrc = (Array.isArray(orderItems) && orderItems.length)
      ? orderItems
      : (
          (Array.isArray(raw.OrderItems) && raw.OrderItems.length ? raw.OrderItems : null) ||
          (Array.isArray(raw.orderItems) && raw.orderItems.length ? raw.orderItems : null) ||
          (Array.isArray(raw.items)      && raw.items.length      ? raw.items      : null) ||
          (Array.isArray(raw.lines)      && raw.lines.length      ? raw.lines      : null) ||
          []
        );

    const items = itemsSrc.map(i => {
      const qty = parseInt(
        _pickFirst(i.QuantityOrdered, i.quantityOrdered, i.quantity, i.qty, 1),
        10
      ) || 1;

      const price = parseFloat(
        _pickFirst(
          i.ItemPrice?.Amount,
          i.itemPrice?.amount,
          i.proceeds?.itemPrice?.amount,
          i.price,
          0
        )
      ) || 0;

      return {
        name:        _pickFirst(i.Title, i.title, i.name, i.productName, i.ASIN, i.asin, 'Produit Amazon'),
        title:       _pickFirst(i.Title, i.title, i.name, i.productName, i.ASIN, i.asin, 'Produit Amazon'),
        sku:         _pickFirst(i.SellerSKU, i.sellerSku, i.sku, ''),
        asin:        _pickFirst(i.ASIN, i.asin, ''),
        orderItemId: _pickFirst(i.OrderItemId, i.orderItemId, ''),
        qty,
        quantity: qty,
        price,
        total: price * qty,
        ean: _pickFirst(i.ASIN, i.asin, ''),
      };
    });

    const shippingAddress = raw.ShippingAddress || raw.shippingAddress || (
      raw.recipient?.deliveryAddress
        ? {
            Name:          _pickFirst(raw.buyer?.buyerName, raw.recipient.deliveryAddress.name, ''),
            AddressLine1:  raw.recipient.deliveryAddress.addressLine1 || '',
            AddressLine2:  raw.recipient.deliveryAddress.addressLine2 || '',
            AddressLine3:  raw.recipient.deliveryAddress.addressLine3 || '',
            City:          raw.recipient.deliveryAddress.city || '',
            PostalCode:    raw.recipient.deliveryAddress.postalCode || '',
            StateOrRegion: raw.recipient.deliveryAddress.stateOrRegion || '',
            CountryCode:   raw.recipient.deliveryAddress.countryCode || 'FR',
            Phone:         raw.recipient.deliveryAddress.phone || '',
          }
        : undefined
    );

    const enrichedRaw = {
      ...raw,

      orderId: orderId,
      AmazonOrderId: orderId,
      amazonOrderId: orderId,

      OrderStatus: statusRaw,
      orderStatus: statusRaw,
      status: statusRaw,

      PurchaseDate: created_at,
      purchaseDate: created_at,
      createdAt: created_at,

      OrderItems: items.length ? items : (raw.OrderItems || []),
      orderItems: items.length ? items : (raw.orderItems || []),
      items,
      lines: items,

      BuyerInfo: {
        BuyerName:  buyer_name,
        BuyerEmail: buyer_email,
        Phone:      buyer_phone,
      },
      buyerInfo: {
        buyerName:  buyer_name,
        buyerEmail: buyer_email,
        phone:      buyer_phone,
      },
      buyer: {
        buyerName:  raw.buyer?.buyerName  || '',
        buyerEmail: raw.buyer?.buyerEmail || buyer_email,
        name:       buyer_name,
        email:      buyer_email,
        phone:      buyer_phone || raw.buyer?.phone || '',
      },
      BuyerName:  buyer_name,
      buyerName:  buyer_name,
      BuyerEmail: buyer_email,
      buyerEmail: buyer_email,

      ShippingAddress: shippingAddress,
      shippingAddress: shippingAddress,

      OrderTotal: { Amount: total_amount, CurrencyCode: currency },
      orderTotal: { amount: total_amount, currencyCode: currency },

      _raw: raw,
    };

    return {
      id: orderId,
      marketplace_id: orderId,
      marketplace: 'amazon',
      status,
      created_at,
      buyer_name,
      buyer_email,
      buyer_phone,
      total: total_amount,
      total_amount,
      currency,
      items,
      lines: items,
      raw: enrichedRaw,
      _raw: enrichedRaw,
      raw_payload: JSON.stringify(enrichedRaw),
    };
  } catch (e) {
    Logger.error('amazon-connector', 'NORMALIZE_ORDER_FAIL', {
      err: _safeStr(e),
      orderId: raw?.AmazonOrderId || raw?.amazonOrderId || raw?.orderId || '?',
    });
    return null;
  }
}

// =====================================================================
// EXPORT
// =====================================================================
module.exports = {
  getToken,
  testConnection,
  getOrders,
  getAllOrders,
  getOrder,
  getOrderBuyerInfo,
  getOrderAddress,
  getOrderItems,
  confirmShipment,
  getInventory,
  updateStock,
  updatePrice,
  requestReport,
  getCatalogItem,
  normalizeOrder,
};