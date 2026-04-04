'use strict';
/**
 * services/product-service.js — Catalogue produits maître
 */

const { getDB } = require('../db/database');
const Logger    = require('../utils/logger');

const ProductService = {
  /** Créer ou mettre à jour un produit */
  async upsertProduct(tenantId, product) {
    const db  = getDB();
    const row = {
      company_id:     tenantId,
      sku:            product.sku,
      ean:            product.ean           || null,
      asin:           product.asin          || null,
      title:          product.title,
      brand:          product.brand         || null,
      category:       product.category      || null,
      buy_price:      Math.round((product.buy_price || 0) * 100),    // centimes
      selling_price:  Math.round((product.selling_price || 0) * 100),
      weight_grams:   product.weight_grams  || 0,
      img1:           product.img1          || null,
      img2:           product.img2          || null,
      img3:           product.img3          || null,
      description:    product.description   || null,
      status:         product.status        || 'active',
      source_mp:      product.source_mp     || null,
      updated_at:     new Date().toISOString(),
    };
    const result = await db.upsert('products', row, 'company_id,sku');
    Logger.info('product-service', 'UPSERT', { sku: product.sku });
    return result;
  },

  /** Récupérer le catalogue avec filtres et pagination */
  async getProducts(tenantId, filters = {}, pagination = {}) {
    const db = getDB();
    const { status, brand, category } = filters;
    const { page = 1, pageSize = 50 }  = pagination;
    const dbFilters = { company_id: tenantId };
    if (status)   dbFilters.status   = status;
    if (brand)    dbFilters.brand    = brand;
    if (category) dbFilters.category = category;

    const products = await db.findMany('products', dbFilters, {
      order: 'updated_at', asc: false,
      limit: pageSize, offset: (page - 1) * pageSize,
    });
    const total = await db.count('products', dbFilters);
    return { products, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  },

  /** Récupérer un produit par SKU */
  async getProductBySku(tenantId, sku) {
    return getDB().findOne('products', { company_id: tenantId, sku });
  },

  /** Récupérer un produit par EAN */
  async getProductByEan(tenantId, ean) {
    return getDB().findOne('products', { company_id: tenantId, ean });
  },

  /** Supprimer un produit */
  async deleteProduct(tenantId, sku) {
    await getDB().update('products', { company_id: tenantId, sku }, { status: 'deleted' });
    Logger.audit('PRODUCT_DELETED', tenantId, { sku });
  },

  /** Importer un lot de produits (CSV/XLSX parsed) */
  async bulkImport(tenantId, products) {
    let created = 0, updated = 0, errors = 0;
    for (const p of products) {
      try {
        await ProductService.upsertProduct(tenantId, p);
        created++;
      } catch(e) {
        Logger.error('product-service', 'BULK_IMPORT_FAIL', { sku: p.sku, error: e.message });
        errors++;
      }
    }
    Logger.info('product-service', 'BULK_IMPORT_DONE', { created, errors });
    return { created, updated, errors };
  },

  /** Stats produits pour dashboard */
  async getStats(tenantId) {
    const db  = getDB();
    const all = await db.findMany('products', { company_id: tenantId });
    return {
      total:    all.length,
      active:   all.filter(p => p.status === 'active').length,
      inactive: all.filter(p => p.status === 'inactive').length,
      with_ean: all.filter(p => p.ean).length,
      with_img: all.filter(p => p.img1).length,
    };
  },
};

module.exports = ProductService;
