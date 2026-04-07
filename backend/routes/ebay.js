'use strict';

const express         = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimit }   = require('../middleware/validation');
const { CredentialStore } = require('../db/credentials-store');
const EbayConnector   = require('../connectors/ebay-connector');
const OrderService    = require('../services/order-service');
const Logger          = require('../utils/logger');

const router = express.Router();
router.use(requireAuth, rateLimit(30));

async function getCreds(req) {
  let creds = req.body?.credentials;
  if (!creds) creds = await CredentialStore.load(req.tenantId, 'ebay');
  if (!creds?.user_token && !creds?.access_token && !creds?.token) {
    throw Object.assign(new Error('Credentials eBay non configurés'), { status: 401 });
  }
  return creds;
}

// ── Health ────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ ok: true, route: 'ebay' });
});

// ── Test connexion ────────────────────────────────────────────
router.post('/test', async (req, res, next) => {
  try {
    const creds = await getCreds(req);
    const result = await EbayConnector.testConnection(creds);
    res.json(result);
  } catch (e) { next(e); }
});

// ── Sync commandes ────────────────────────────────────────────
router.post('/sync', async (req, res, next) => {
  try {
    const creds  = await getCreds(req);
    const result = await EbayConnector.getOrders(creds, req.body);
    // Normalisation déjà faite dans le connecteur
    const orders = result.orders.filter(Boolean);
    Logger.info('ebay-route', 'SYNC_OK', { count: orders.length });
    res.json({ ok: true, orders, total: result.total });
  } catch (e) { next(e); }
});

// ── Détail commande ───────────────────────────────────────────
router.get('/order/:orderId', async (req, res, next) => {
  try {
    const creds = await getCreds(req);
    const order = await EbayConnector.getOrder(creds, req.params.orderId);
    res.json({ ok: true, order });
  } catch (e) { next(e); }
});

// ── Confirmer expédition ──────────────────────────────────────
router.post('/ship', async (req, res, next) => {
  try {
    const creds  = await getCreds(req);
    const result = await EbayConnector.confirmShipment(creds, req.body);
    Logger.audit('SHIPMENT_CONFIRMED', req.tenantId, { marketplace: 'ebay', ...result });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// ── Mettre à jour le stock ────────────────────────────────────
router.post('/stock', async (req, res, next) => {
  try {
    const { sku, quantity } = req.body;
    if (!sku || quantity === undefined) {
      return res.status(400).json({ error: 'sku et quantity requis' });
    }
    const creds  = await getCreds(req);
    const result = await EbayConnector.updateStock(creds, sku, quantity);
    Logger.audit('STOCK_UPDATED', req.tenantId, { marketplace: 'ebay', sku, quantity });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// ── Créer/mettre à jour une annonce ──────────────────────────
router.post('/listing', async (req, res, next) => {
  try {
    const creds  = await getCreds(req);
    const result = await EbayConnector.upsertListing(creds, req.body);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
