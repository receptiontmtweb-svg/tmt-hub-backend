'use strict';
/**
 * services/stock-service.js — Gestion des stocks multi-marketplace
 */

const { getDB }          = require('../db/database');
const { CredentialStore, TokenCache } = require('../db/credentials-store');
const AmazonConnector    = require('../connectors/amazon-connector');
const OctopiaConnector   = require('../connectors/octopia-connector');
const Logger             = require('../utils/logger');

async function _getToken(marketplace, tenantId) {
  const cached = TokenCache.get(marketplace, tenantId);
  if (cached) return cached;
  const creds = await CredentialStore.load(tenantId, marketplace);
  if (!creds) throw Object.assign(new Error(`Credentials ${marketplace} non configurés`), { status: 401 });
  const connectors = { amazon: AmazonConnector, cdiscount: OctopiaConnector };
  const token = await connectors[marketplace]?.getToken(creds);
  if (token) TokenCache.set(marketplace, tenantId, token, 3500);
  return token;
}

const StockService = {
  /**
   * Synchroniser les stocks depuis la marketplace vers la DB
   */
  async syncStock(tenantId, marketplace) {
    const db  = getDB();
    const t0  = Date.now();
    let synced = 0;

    if (marketplace === 'amazon') {
      const token = await _getToken('amazon', tenantId);
      const { summaries } = await AmazonConnector.getInventory(token);
      for (const item of summaries) {
        await db.upsert('stock_items', {
          company_id:    tenantId,
          marketplace,
          sku:           item.sellerSku,
          asin:          item.asin,
          quantity:      item.totalQuantity || 0,
          updated_at:    new Date().toISOString(),
        }, 'company_id,marketplace,sku');
        synced++;
      }
    } else if (marketplace === 'cdiscount') {
      const token  = await _getToken('cdiscount', tenantId);
      const offers = await OctopiaConnector.getOffers(token, { all: true });
      for (const offer of offers) {
        await db.upsert('stock_items', {
          company_id:    tenantId,
          marketplace,
          sku:           offer.SellerProductId,
          quantity:      offer.Stock || 0,
          price:         Math.round((offer.Price || 0) * 100),
          updated_at:    new Date().toISOString(),
        }, 'company_id,marketplace,sku');
        synced++;
      }
    } else {
      throw new Error(`syncStock non supporté pour ${marketplace}`);
    }

    const duration = Date.now() - t0;
    Logger.info('stock-service', 'SYNC_DONE', { marketplace, synced, duration_ms: duration });

    await db.insert('sync_logs', {
      company_id: tenantId, marketplace, job_type: 'stock',
      status: 'success', records_in: synced, records_out: synced, duration_ms: duration,
    });
    return { synced, duration_ms: duration };
  },

  /**
   * Mettre à jour le stock d'un produit sur une ou plusieurs marketplaces
   */
  async updateStock(tenantId, sku, quantity, marketplaces = []) {
    const results = {};
    for (const marketplace of marketplaces) {
      try {
        const token = await _getToken(marketplace, tenantId);
        if (marketplace === 'amazon') {
          const creds = await CredentialStore.load(tenantId, 'amazon');
          results[marketplace] = await AmazonConnector.updateStock(token, creds?.seller_id, sku, quantity);
        } else if (marketplace === 'cdiscount') {
          results[marketplace] = await OctopiaConnector.updateStock(token, [{ SellerProductId: sku, Stock: quantity }]);
        }
        const db = getDB();
        await db.update('stock_items', { company_id: tenantId, marketplace, sku }, { quantity, updated_at: new Date().toISOString() });
        Logger.audit('STOCK_UPDATED', tenantId, { marketplace, sku, quantity });
      } catch(e) {
        results[marketplace] = { error: e.message };
        Logger.error('stock-service', 'UPDATE_FAIL', { marketplace, sku, error: e.message });
      }
    }
    return results;
  },

  /** Stocks depuis la DB */
  async getStockItems(tenantId, filters = {}) {
    const db = getDB();
    const dbFilters = { company_id: tenantId };
    if (filters.marketplace) dbFilters.marketplace = filters.marketplace;
    if (filters.sku)         dbFilters.sku         = filters.sku;
    return db.findMany('stock_items', dbFilters, { order: 'quantity', asc: true });
  },

  /** Produits en rupture de stock */
  async getLowStock(tenantId, threshold = 5) {
    const items = await StockService.getStockItems(tenantId);
    return items.filter(i => i.quantity <= threshold);
  },
};

module.exports = StockService;
