'use strict';
/**
 * services/order-service.js — Logique métier commandes
 * Centralise : fetch multi-MP, normalisation, persistance, sync
 */

const { getDB } = require('../db/database');
const { CredentialStore, TokenCache } = require('../db/credentials-store');
const AmazonConnector = require('../connectors/amazon-connector');
const OctopiaConnector = require('../connectors/octopia-connector');
const Logger = require('../utils/logger');

const CONNECTORS = {
  amazon: {
    connector: AmazonConnector,
    normalize: AmazonConnector.normalizeOrder,
  },
  cdiscount: {
    connector: OctopiaConnector,
    normalize: OctopiaConnector.normalizeOrder,
  },
};

async function _getToken(marketplace, tenantId, inlineCreds = null) {
  const cached = TokenCache.get(marketplace, tenantId);
  if (cached) return cached;

  const creds = inlineCreds || await CredentialStore.load(tenantId, marketplace);
  if (!creds) {
    throw Object.assign(
      new Error(`Credentials ${marketplace} non configurés`),
      { status: 401 }
    );
  }

  const mp = CONNECTORS[marketplace];
  if (!mp) throw new Error(`Connecteur ${marketplace} non disponible`);

  const token = await mp.connector.getToken(creds);
  TokenCache.set(marketplace, tenantId, token, 3500);
  return token;
}

function _extractOrders(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];

  if (Array.isArray(result.orders)) return result.orders;
  if (Array.isArray(result.Orders)) return result.Orders;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.List)) return result.List;
  if (Array.isArray(result.OrderList)) return result.OrderList;
  if (Array.isArray(result.Results)) return result.Results;

  return [];
}

function _safeJsonParse(value, fallback = null) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function _pickFirst(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return v;
    }
  }
  return '';
}

function _fullName(first, last) {
  return `${first || ''} ${last || ''}`.trim();
}

function _looksLikePostalCode(value = '') {
  return /^\d{4,6}$/.test(String(value).trim());
}

function _looksLikeAddressOrCity(value = '') {
  const s = String(value || '').trim();
  if (!s) return false;

  if (_looksLikePostalCode(s)) return true;
  if (/^\d{4,6}\s+[A-Za-zÀ-ÿ' -]+$/i.test(s)) return true;       // 46000 CAHORS
  if (/^[A-Za-zÀ-ÿ' -]+\s+\d{4,6}$/i.test(s)) return true;       // GAREOULT 83136
  if (/^\d{1,4}[A-Za-z]?\s+/.test(s)) return true;               // 12 RUE ...
  if (/\b(rue|avenue|av|boulevard|bd|chemin|route|impasse|lieu-dit|lotissement|residence|résidence)\b/i.test(s)) return true;

  const digits = (s.match(/\d/g) || []).length;
  if (digits >= 3) return true;

  return false;
}

function _cleanPersonName(value = '') {
  const s = String(value || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (_looksLikeAddressOrCity(s)) return '';
  if (s.length < 2) return '';
  return s;
}

function _firstLine(raw = {}) {
  return Array.isArray(raw?.lines) && raw.lines.length ? raw.lines[0] : null;
}

function _extractBuyerName(order, raw) {
  const line0 = _firstLine(raw);

  return _pickFirst(
    _cleanPersonName(order?.buyer_name),
    _cleanPersonName(order?.buyer),
    _cleanPersonName(order?.customer_name),

    // Amazon SP-API v2026 (camelCase)
    _cleanPersonName(raw?.buyer?.buyerName),
    _cleanPersonName(raw?.buyer?.name),
    _cleanPersonName(raw?.recipient?.deliveryAddress?.name),

    // Amazon SP-API legacy (PascalCase)
    _cleanPersonName(raw?.ShippingAddress?.Name),
    _cleanPersonName(raw?.BuyerName),
    _cleanPersonName(raw?.BuyerInfo?.BuyerName),

    // Cdiscount / autres
    _cleanPersonName(raw?.billingAddress?.fullName),
    _cleanPersonName(_fullName(raw?.billingAddress?.firstName, raw?.billingAddress?.lastName)),

    _cleanPersonName(raw?.shippingAddress?.fullName),
    _cleanPersonName(_fullName(raw?.shippingAddress?.firstName, raw?.shippingAddress?.lastName)),

    _cleanPersonName(line0?.shippingAddress?.fullName),
    _cleanPersonName(_fullName(line0?.shippingAddress?.firstName, line0?.shippingAddress?.lastName)),

    _cleanPersonName(raw?.customer?.fullName),
    _cleanPersonName(_fullName(raw?.customer?.firstName, raw?.customer?.lastName)),

    _cleanPersonName(raw?.customerName),
    _cleanPersonName(raw?.buyerName),
    _cleanPersonName(raw?.shippingName),
    _cleanPersonName(raw?.recipientName),

    'Client'
  );
}

function _extractBuyerEmail(order, raw) {
  const line0 = _firstLine(raw);

  return _pickFirst(
    order?.buyer_email,

    // Amazon SP-API v2026 (camelCase)
    raw?.buyer?.buyerEmail,
    raw?.buyer?.email,

    // Amazon legacy (PascalCase)
    raw?.BuyerEmail,
    raw?.BuyerInfo?.BuyerEmail,
    raw?.buyerEmail,

    // Cdiscount / autres
    line0?.shippingAddress?.email,
    raw?.shippingAddress?.email,
    raw?.billingAddress?.email,
    raw?.customer?.email,
    raw?.buyer?.email,
    raw?.contact?.email,
    raw?.email,
    ''
  );
}

function _extractCreatedAt(order, raw) {
  return _pickFirst(
    order?.created_at,
    order?.createdAt,
    order?.purchase_date,

    raw?.createdTime,

    raw?.purchasedAt,
    raw?.createdAt,
    raw?.updatedAt,
    raw?.creationDate,
    raw?.created_at,
    raw?.purchaseDate,
    raw?.PurchaseDate,
    raw?.orderDate,
    raw?.creation_date,

    new Date().toISOString()
  );
}

function _extractShippingAddress(raw = {}) {
  const line0 = Array.isArray(raw?.lines) && raw.lines.length ? raw.lines[0] : null;

  // Amazon SP-API v2026 (camelCase)
  const amzRecip = raw?.recipient?.deliveryAddress || {};
  const hasAmzRecip = !!(
    amzRecip?.addressLine1 ||
    amzRecip?.city ||
    amzRecip?.postalCode ||
    amzRecip?.name
  );

  if (hasAmzRecip) {
    const buyerName = _pickFirst(
      _cleanPersonName(raw?.buyer?.buyerName),
      _cleanPersonName(raw?.buyer?.name),
      _cleanPersonName(amzRecip?.name),
      ''
    );

    const buyerEmail = _pickFirst(
      raw?.buyer?.buyerEmail,
      raw?.buyer?.email,
      ''
    );

    return {
      name: buyerName,
      line1: amzRecip.addressLine1 || '',
      line2: amzRecip.addressLine2 || '',
      line3: amzRecip.addressLine3 || '',
      city: amzRecip.city || '',
      postal_code: amzRecip.postalCode || '',
      state: amzRecip.stateOrRegion || '',
      country: amzRecip.countryCode || 'FR',
      phone: _pickFirst(amzRecip.phone, raw?.buyer?.phone, ''),
      email: buyerEmail,

      // Alias front
      address1: amzRecip.addressLine1 || '',
      address2: amzRecip.addressLine2 || '',
      address3: amzRecip.addressLine3 || '',
      postalCode: amzRecip.postalCode || '',
      countryCode: amzRecip.countryCode || 'FR',
    };
  }

  // Amazon legacy (PascalCase)
  const amzShip = raw?.ShippingAddress || raw?.shippingAddress || {};
  const hasAmzAddress = !!(
    amzShip?.AddressLine1 ||
    amzShip?.City ||
    amzShip?.PostalCode ||
    amzShip?.Name
  );

  if (hasAmzAddress) {
    return {
      name: _pickFirst(
        _cleanPersonName(amzShip.Name),
        _cleanPersonName(raw?.BuyerName),
        _cleanPersonName(raw?.buyer_name),
        ''
      ),
      line1: amzShip.AddressLine1 || '',
      line2: amzShip.AddressLine2 || '',
      line3: amzShip.AddressLine3 || '',
      city: amzShip.City || '',
      postal_code: amzShip.PostalCode || amzShip.PostCode || '',
      state: amzShip.StateOrRegion || '',
      country: amzShip.CountryCode || 'FR',
      phone: _pickFirst(amzShip.Phone, raw?.phone, ''),
      email: _pickFirst(raw?.BuyerEmail, raw?.buyer_email, raw?.BuyerInfo?.BuyerEmail, ''),

      // Alias front
      address1: amzShip.AddressLine1 || '',
      address2: amzShip.AddressLine2 || '',
      address3: amzShip.AddressLine3 || '',
      postalCode: amzShip.PostalCode || amzShip.PostCode || '',
      countryCode: amzShip.CountryCode || 'FR',
    };
  }

  // Cdiscount / autres
  const shipping = line0?.shippingAddress || {};
  const billing = raw?.billingAddress || {};

  return {
    name: _pickFirst(
      shipping?.fullName,
      _fullName(shipping?.firstName, shipping?.lastName),
      billing?.fullName,
      _fullName(billing?.firstName, billing?.lastName),
      ''
    ),
    line1: _pickFirst(
      shipping?.addressLine1,
      shipping?.address1,
      billing?.addressLine1,
      billing?.address1,
      ''
    ),
    line2: _pickFirst(
      shipping?.addressLine2,
      shipping?.address2,
      billing?.addressLine2,
      billing?.address2,
      ''
    ),
    city: _pickFirst(
      shipping?.city,
      billing?.city,
      ''
    ),
    postal_code: _pickFirst(
      shipping?.postalCode,
      shipping?.zipCode,
      billing?.postalCode,
      billing?.zipCode,
      ''
    ),
    country: _pickFirst(
      shipping?.countryCode,
      billing?.countryCode,
      'FR'
    ),
    phone: _pickFirst(
      shipping?.phone,
      billing?.phone,
      ''
    ),
    email: _pickFirst(
      shipping?.email,
      billing?.email,
      ''
    ),

    // Alias front
    address1: _pickFirst(shipping?.addressLine1, shipping?.address1, billing?.addressLine1, billing?.address1, ''),
    address2: _pickFirst(shipping?.addressLine2, shipping?.address2, billing?.addressLine2, billing?.address2, ''),
    postalCode: _pickFirst(shipping?.postalCode, shipping?.zipCode, billing?.postalCode, billing?.zipCode, ''),
    countryCode: _pickFirst(shipping?.countryCode, billing?.countryCode, 'FR'),
  };
}

function _extractLines(raw = {}) {
  const amzItems =
    Array.isArray(raw?.OrderItems) ? raw.OrderItems :
    Array.isArray(raw?.orderItems) ? raw.orderItems :
    null;

  if (amzItems && amzItems.length) {
    return amzItems.map((i) => {
      const qty = parseInt(_pickFirst(i?.QuantityOrdered, i?.quantityOrdered, i?.quantity, i?.qty, 1), 10) || 1;
      const unitPrice = parseFloat(
        _pickFirst(
          i?.ItemPrice?.Amount,
          i?.itemPrice?.amount,
          i?.proceeds?.itemPrice?.amount,
          i?.price,
          0
        ) || 0
      );

      return {
        name: _pickFirst(i?.Title, i?.title, i?.name, i?.productName, i?.ASIN, i?.asin, 'Produit Amazon'),
        title: _pickFirst(i?.Title, i?.title, i?.name, i?.productName, i?.ASIN, i?.asin, 'Produit Amazon'),
        sku: _pickFirst(i?.SellerSKU, i?.sellerSku, i?.sku, ''),
        asin: _pickFirst(i?.ASIN, i?.asin, ''),
        qty,
        quantity: qty,
        price: unitPrice,
        total: unitPrice * qty,
        ean: _pickFirst(i?.ASIN, i?.asin, ''),
      };
    });
  }

  const src =
    (Array.isArray(raw?.lines) && raw.lines) ||
    (Array.isArray(raw?.items) && raw.items) ||
    (Array.isArray(raw?.orderLines) && raw.orderLines) ||
    (Array.isArray(raw?.products) && raw.products) ||
    (Array.isArray(raw?.offers) && raw.offers) ||
    [];

  return src.map((i) => ({
    name: _pickFirst(
      i?.offer?.productTitle,
      i?.productName,
      i?.offerName,
      i?.productTitle,
      i?.label,
      i?.name,
      'Produit'
    ),
    sku: _pickFirst(
      i?.offer?.sellerProductId,
      i?.sellerProductId,
      i?.sellerSku,
      i?.sku,
      i?.productSku,
      i?.offerSku,
      ''
    ),
    qty: Number(_pickFirst(i?.quantity, i?.qty, 1) || 1),
    quantity: Number(_pickFirst(i?.quantity, i?.qty, 1) || 1),
    price: Number(
      _pickFirst(
        i?.sellingPrice?.unitSalesPrice,
        i?.offerPrice?.unitSalesPrice,
        i?.price,
        i?.unitPrice,
        i?.sellingPrice,
        0
      ) || 0
    ),
    total: Number(
      _pickFirst(
        i?.totalPrice?.sellingPrice,
        i?.totalPrice?.offerPrice,
        0
      ) || 0
    ),
    ean: _pickFirst(
      i?.offer?.productGtin,
      i?.ean,
      i?.gtin,
      ''
    ),
    delivery_mode: _pickFirst(i?.delivery?.mode, ''),
  }));
}

function _isMondialRelay(raw = {}) {
  const line0 = _firstLine(raw);
  const mode = _pickFirst(
    line0?.delivery?.mode,
    raw?.delivery?.mode,
    raw?.shippingMode,
    raw?.deliveryMode,
    ''
  );
  return /relay|pickup|mondial/i.test(mode);
}

function _buildOrderView(row) {
  const raw = _safeJsonParse(row?.raw_payload, {}) || {};

  const buyer_name_raw = _extractBuyerName(row, raw);

  const buyer_name = (buyer_name_raw && buyer_name_raw !== 'Client')
    ? buyer_name_raw
    : _pickFirst(
        _cleanPersonName(raw?.ShippingAddress?.Name),
        _cleanPersonName(raw?.shippingAddress?.Name),
        _cleanPersonName(raw?.recipient?.deliveryAddress?.name),
        row?.marketplace === 'amazon' ? '' : 'Client'
      );

  const buyer_email = _extractBuyerEmail(row, raw);
  const created_at = _extractCreatedAt(row, raw);
  const shipping_address = _extractShippingAddress(raw);

  if (!shipping_address.name && _cleanPersonName(row?.buyer_name)) {
    shipping_address.name = _cleanPersonName(row?.buyer_name);
  }

  const lines = _extractLines(raw);
  const line0 = _firstLine(raw);

  const delivery_mode = _pickFirst(
    line0?.delivery?.mode,
    raw?.delivery?.mode,
    raw?.shippingMode,
    raw?.deliveryMode,
    ''
  );

  const is_mondial_relay = _isMondialRelay(raw);

  // Amazon : si pas de vrai nom PII, on laisse vide
  const display_buyer = row?.marketplace === 'amazon'
    ? _pickFirst(
        _cleanPersonName(raw?.BuyerName),
        _cleanPersonName(raw?.buyer?.buyerName),
        _cleanPersonName(raw?.BuyerInfo?.BuyerName),
        ''
      )
    : _pickFirst(
        buyer_name,
        _cleanPersonName(shipping_address?.name),
        _cleanPersonName(row?.buyer_name),
        ''
      );

  return {
    ...row,
    raw,

    id: row?.id,

    display_id: _pickFirst(
      raw?.AmazonOrderId,
      raw?.orderId,
      raw?.reference,
      raw?.marketplace_id,
      row?.marketplace_id,
      row?.id
    ),

    marketplace: row?.marketplace,

    marketplace_id: _pickFirst(
      raw?.AmazonOrderId,
      raw?.orderId,
      raw?.reference,
      raw?.marketplace_id,
      row?.marketplace_id,
      row?.id
    ),

    status: row?.status,

    created_at,
    createdAt: created_at,
    order_date: created_at,

    buyer_name: display_buyer,
    buyer_email,
    buyer: display_buyer,
    customer_name: display_buyer,

    total: row?.total_amount,
    total_amount: row?.total_amount,
    currency: row?.currency,

    customer: {
      name: display_buyer,
      email: buyer_email,
    },

    client: raw?.client || {
      name: display_buyer,
      email: buyer_email,
      phone: shipping_address?.phone || '',
      address: shipping_address?.line1 || shipping_address?.address1 || '',
      zip: shipping_address?.postal_code || shipping_address?.postalCode || '',
      city: shipping_address?.city || '',
      country: shipping_address?.country || shipping_address?.countryCode || 'FR',
    },

    shipping_name: row?.marketplace === 'amazon'
      ? ''
      : (_cleanPersonName(shipping_address.name) || display_buyer),

    shipping_address,
    address: shipping_address,
    shippingAddress: shipping_address,

    lines,
    items: lines,

    delivery_mode,
    is_mondial_relay,

    relay_alert: is_mondial_relay
      ? '⚠️ Livraison Mondial Relay / point relais'
      : '',
  };
}

const OrderService = {
  async syncOrders(tenantId, marketplace, opts = {}) {
    const t0 = Date.now();
    const db = getDB();
    const mp = CONNECTORS[marketplace];

    if (!mp) throw new Error(`Marketplace ${marketplace} non supportée`);

    const creds = opts?.credentials || await CredentialStore.load(tenantId, marketplace);
    if (!creds) {
      throw Object.assign(
        new Error(`Credentials ${marketplace} non configurés`),
        { status: 401 }
      );
    }

    const token = await _getToken(marketplace, tenantId, creds);

    const sellerId =
      creds?.sellerId || creds?.seller_id || creds?.SellerId || '19281';

    const effectiveOpts = { ...opts };

    if (
      marketplace === 'cdiscount' &&
      (!effectiveOpts.statuses || !effectiveOpts.statuses.length)
    ) {
      effectiveOpts.statuses = [
        'WaitingForShipmentAcceptation',
        'ShippingConfirmed',
        'InPreparation',
      ];
    }

    let rawResult;
    if (effectiveOpts.all) {
      rawResult = await mp.connector.getAllOrders(token, {
        ...effectiveOpts,
        sellerId,
      });
    } else {
      rawResult = await mp.connector.getOrders(token, {
        ...effectiveOpts,
        sellerId,
      });
    }

    const raw = _extractOrders(rawResult);

    if (marketplace === 'amazon' && raw.length > 0) {
      console.log('AMZ_RAW_SAMPLE:', JSON.stringify(raw[0], null, 2));
    }

    Logger.info('order-service', 'RAW_ORDERS_FETCHED', {
      marketplace,
      count: raw.length,
      resultType: Array.isArray(rawResult) ? 'array' : typeof rawResult,
      keys: rawResult && typeof rawResult === 'object' ? Object.keys(rawResult) : [],
      opts: effectiveOpts,
      sellerId,
    });

    let enrichedRaw = raw;

    if (marketplace === 'amazon') {
      let withAddress = 0;
      let withItems = 0;
      let withBuyer = 0;
      let enrichErrors = 0;

      const MAX_AMZ_ENRICH = 50;
      const CONCURRENCY = 1;

      const rawToEnrich = raw.filter(o => {
        const hasBuyer = o?.buyer?.buyerName || o?.BuyerName;
        const hasAddress =
          o?.recipient?.deliveryAddress?.addressLine1 ||
          o?.ShippingAddress?.AddressLine1;

        return !hasBuyer || !hasAddress;
      }).slice(0, MAX_AMZ_ENRICH);

      const rawWithoutEnrich = raw.filter(o => !rawToEnrich.includes(o));

      enrichedRaw = [];

      for (let i = 0; i < rawToEnrich.length; i += CONCURRENCY) {
        const batch = rawToEnrich.slice(i, i + CONCURRENCY);

        const results = await Promise.all(batch.map(async (order) => {
          const orderId = order?.orderId || order?.AmazonOrderId || order?.amazonOrderId;

          if (!orderId) {
            Logger.warn('order-service', 'AMZ_ENRICH_SKIP', {
              reason: 'orderId Amazon manquant',
              keys: Object.keys(order || {}).slice(0, 10).join(', '),
              sample: JSON.stringify(order || {}).slice(0, 200),
            });
            enrichErrors++;
            return order;
          }

          let merged = { ...order };

          const hasBuyer = !!(
            merged?.buyer?.buyerName ||
            merged?.buyer?.buyerEmail ||
            merged?.BuyerName ||
            merged?.BuyerEmail ||
            merged?.BuyerInfo?.BuyerName ||
            merged?.BuyerInfo?.BuyerEmail
          );

          const hasAddress = !!(
            merged?.recipient?.deliveryAddress?.addressLine1 ||
            merged?.recipient?.deliveryAddress?.city ||
            merged?.recipient?.deliveryAddress?.postalCode ||
            merged?.recipient?.deliveryAddress?.name ||
            merged?.ShippingAddress?.AddressLine1 ||
            merged?.ShippingAddress?.City ||
            merged?.ShippingAddress?.PostalCode ||
            merged?.ShippingAddress?.Name
          );

          if (!hasBuyer || !hasAddress) {
            try {
              const detail = await AmazonConnector.getOrder(token, orderId);
              if (detail && typeof detail === 'object') {
                merged = { ...merged, ...detail };

                if (detail?.buyer) merged.buyer = detail.buyer;
                if (detail?.recipient) merged.recipient = detail.recipient;
                if (detail?.BuyerInfo) merged.BuyerInfo = detail.BuyerInfo;
                if (detail?.ShippingAddress) merged.ShippingAddress = detail.ShippingAddress;
              }
            } catch (e) {
              Logger.warn('order-service', 'AMZ_DETAIL_FAIL', {
                orderId,
                error: e.message,
              });
              enrichErrors++;
            }
          }

          if (
            merged?.recipient?.deliveryAddress?.addressLine1 ||
            merged?.recipient?.deliveryAddress?.city ||
            merged?.recipient?.deliveryAddress?.postalCode ||
            merged?.recipient?.deliveryAddress?.name ||
            merged?.ShippingAddress?.AddressLine1 ||
            merged?.ShippingAddress?.City ||
            merged?.ShippingAddress?.PostalCode ||
            merged?.ShippingAddress?.Name
          ) {
            withAddress++;
          }

          if (
            merged?.buyer?.buyerName ||
            merged?.buyer?.buyerEmail ||
            merged?.BuyerName ||
            merged?.BuyerEmail ||
            merged?.BuyerInfo?.BuyerName ||
            merged?.BuyerInfo?.BuyerEmail
          ) {
            withBuyer++;
          }

          try {
            let orderItems = Array.isArray(merged?.orderItems) ? merged.orderItems : [];
            if (!orderItems.length && Array.isArray(merged?.OrderItems)) {
              orderItems = merged.OrderItems;
            }

            if (!orderItems.length) {
              orderItems = await AmazonConnector.getOrderItems(token, orderId);
            }

            if (Array.isArray(orderItems) && orderItems.length) {
              merged.orderItems = orderItems;
              merged.OrderItems = orderItems;
              withItems++;
            }
          } catch (e) {
            Logger.warn('order-service', 'AMZ_ITEMS_FAIL', {
              orderId,
              error: e.message,
            });
            enrichErrors++;
          }

          if (!merged.AmazonOrderId && merged.orderId) {
            merged.AmazonOrderId = merged.orderId;
          }

          if (!merged.BuyerName && merged?.buyer?.buyerName) {
            merged.BuyerName = merged.buyer.buyerName;
          }

          if (!merged.BuyerEmail && merged?.buyer?.buyerEmail) {
            merged.BuyerEmail = merged.buyer.buyerEmail;
          }

          if (!merged.BuyerInfo && (merged.BuyerName || merged.BuyerEmail)) {
            merged.BuyerInfo = {
              BuyerName: merged.BuyerName || '',
              BuyerEmail: merged.BuyerEmail || '',
            };
          }

          if (!merged.ShippingAddress && merged?.recipient?.deliveryAddress) {
            const a = merged.recipient.deliveryAddress;
            merged.ShippingAddress = {
              Name: a?.name || merged?.buyer?.buyerName || '',
              AddressLine1: a?.addressLine1 || '',
              AddressLine2: a?.addressLine2 || '',
              AddressLine3: a?.addressLine3 || '',
              City: a?.city || '',
              PostalCode: a?.postalCode || '',
              StateOrRegion: a?.stateOrRegion || '',
              CountryCode: a?.countryCode || 'FR',
              Phone: a?.phone || '',
            };
          }

          return merged;
        }));

        enrichedRaw.push(...results);

        if (i + CONCURRENCY < rawToEnrich.length) {
          await new Promise((r) => setTimeout(r, 1200));
        }
      }

      enrichedRaw.push(...rawWithoutEnrich);

      Logger.info('order-service', 'AMZ_ENRICH_DONE', {
        total: raw.length,
        enriched: rawToEnrich.length,
        skipped_enrich: rawWithoutEnrich.length,
        withItems,
        withAddress,
        withBuyer,
        enrichErrors,
      });
    }

    const orders = enrichedRaw
      .map((item) => {
        try {
          if (marketplace === 'amazon') {
            return AmazonConnector.normalizeOrder(
              item,
              item?.orderItems || item?.OrderItems || []
            );
          }
          return mp.normalize(item);
        } catch (e) {
          Logger.error('order-service', 'NORMALIZE_FAIL', {
            marketplace,
            error: e.message,
            raw_id: item?.AmazonOrderId || item?.amazonOrderId || item?.orderId || item?.id || '?',
            raw_keys: Object.keys(item || {}).slice(0, 10).join(', '),
          });
          return null;
        }
      })
      .filter(Boolean)
      .filter((order) => order.marketplace_id)
      .filter((order) => {
        if (marketplace !== 'cdiscount') return true;
        return order.status === 'new' || order.status === 'processing';
      });

    let created = 0;
    let updated = 0;
    let errors = 0;

    for (const order of orders) {
      try {
        const rawPayloadToStore = {
          ...(order._raw || order.raw || {}),
        };

        if (!rawPayloadToStore.orderId && order.marketplace_id) {
          rawPayloadToStore.orderId = order.marketplace_id;
        }
        if (!rawPayloadToStore.AmazonOrderId && rawPayloadToStore.orderId) {
          rawPayloadToStore.AmazonOrderId = rawPayloadToStore.orderId;
        }
        if (!rawPayloadToStore.orderItems && Array.isArray(order.items)) {
          rawPayloadToStore.orderItems = order.items;
        }
        if (!rawPayloadToStore.OrderItems && Array.isArray(order.items)) {
          rawPayloadToStore.OrderItems = order.items;
        }

        const buyer_name_raw = _extractBuyerName(order, rawPayloadToStore);
        const buyer_name = buyer_name_raw && buyer_name_raw !== 'Client'
          ? buyer_name_raw
          : _pickFirst(
              _cleanPersonName(rawPayloadToStore?.ShippingAddress?.Name),
              _cleanPersonName(rawPayloadToStore?.shippingAddress?.Name),
              _cleanPersonName(rawPayloadToStore?.recipient?.deliveryAddress?.name),
              marketplace === 'amazon' ? '' : 'Client'
            );

        const buyer_email = _extractBuyerEmail(order, rawPayloadToStore);
        const created_at = _extractCreatedAt(order, rawPayloadToStore);

        await db.upsert(
          'orders',
          {
            company_id: tenantId,
            marketplace,
            marketplace_id: _pickFirst(
              rawPayloadToStore?.AmazonOrderId,
              rawPayloadToStore?.orderId,
              rawPayloadToStore?.reference,
              rawPayloadToStore?.marketplace_id,
              order.marketplace_id
            ),
            buyer_name,
            buyer_email,
            total_amount: order.total,
            currency: order.currency,
            status: order.status,
            created_at,
            raw_payload: JSON.stringify(rawPayloadToStore),
            updated_at: new Date().toISOString(),
          },
          'company_id,marketplace,marketplace_id'
        );

        created++;
      } catch (e) {
        Logger.error('order-service', 'UPSERT_FAIL', {
          marketplace_id: order.marketplace_id,
          error: e.message,
        });
        errors++;
      }
    }

    const duration = Date.now() - t0;

    Logger.info('order-service', 'SYNC_DONE', {
      marketplace,
      raw_count: raw.length,
      normalized_count: orders.length,
      errors,
      duration_ms: duration,
    });

    await db.insert('sync_logs', {
      company_id: tenantId,
      marketplace,
      job_type: 'orders',
      status:
        orders.length === 0
          ? 'success'
          : errors === orders.length
          ? 'error'
          : errors > 0
          ? 'partial'
          : 'success',
      records_in: raw.length,
      records_out: created + updated,
      errors_count: errors,
      duration_ms: duration,
    });

    return {
      ok: true,
      synced: orders.length,
      created,
      updated,
      errors,
      duration_ms: duration,
    };
  },

  async getOrders(tenantId, filters = {}, pagination = {}) {
    const db = getDB();
    const { marketplace, status } = filters;
    const { page = 1, pageSize = 50 } = pagination;

    const dbFilters = { company_id: tenantId };
    if (marketplace) dbFilters.marketplace = marketplace;
    if (status) dbFilters.status = status;

    const rows = await db.findMany('orders', dbFilters, {
      order: 'created_at',
      asc: false,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    const total = await db.count('orders', dbFilters);
    const orders = rows.map(_buildOrderView);

    return {
      orders,
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
    };
  },

  async confirmShipment(
    tenantId,
    marketplace,
    { orderId, orderNumber, items, trackingNumber, carrier, trackingUrl }
  ) {
    const token = await _getToken(marketplace, tenantId);

    let result;
    if (marketplace === 'amazon') {
      result = await AmazonConnector.confirmShipment(token, {
        orderId,
        items,
        trackingNumber,
        carrierCode: carrier,
      });
    } else if (marketplace === 'cdiscount') {
      const creds = await CredentialStore.load(tenantId, marketplace);
      const sellerId =
        creds?.sellerId || creds?.seller_id || creds?.SellerId || '19281';

      result = await OctopiaConnector.confirmShipment(token, {
        orderNumber,
        trackingNumber,
        carrierName: carrier,
        trackingUrl,
        sellerId,
      });
    } else {
      throw new Error(`confirmShipment non supporté pour ${marketplace}`);
    }

    const db = getDB();
    const idField = marketplace === 'amazon' ? orderId : orderNumber;

    await db.update(
      'orders',
      { company_id: tenantId, marketplace, marketplace_id: idField },
      {
        status: 'shipped',
        tracking_number: trackingNumber,
        carrier,
        updated_at: new Date().toISOString(),
      }
    );

    Logger.audit('SHIPMENT_CONFIRMED', tenantId, {
      marketplace,
      orderId: idField,
      trackingNumber,
    });

    return result;
  },

  async getStats(tenantId) {
    const db = getDB();
    const all = await db.findMany('orders', { company_id: tenantId });

    return {
      total: all.length,
      new: all.filter((o) => o.status === 'new').length,
      processing: all.filter((o) => o.status === 'processing').length,
      shipped: all.filter((o) => o.status === 'shipped').length,
      cancelled: all.filter((o) => o.status === 'cancelled').length,
      ca_total: all.reduce((s, o) => s + parseFloat(o.total_amount || 0), 0),
    };
  },
};

module.exports = OrderService;