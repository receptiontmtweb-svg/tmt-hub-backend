'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimit, validate } = require('../middleware/validation');
const ProductService = require('../services/product-service');

const router = express.Router();
router.use(requireAuth, rateLimit(60));

router.get('/health', (req, res) => {
  res.json({ ok: true, route: 'products' });
});

router.get('/', async (req, res, next) => {
  try {
    const { status, brand, category, page, pageSize } = req.query;
    res.json({
      ok: true,
      ...(await ProductService.getProducts(
        req.tenantId,
        { status, brand, category },
        { page: +page || 1, pageSize: +pageSize || 50 }
      ))
    });
  } catch (e) {
    next(e);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    res.json({ ok: true, stats: await ProductService.getStats(req.tenantId) });
  } catch (e) {
    next(e);
  }
});

router.get('/:sku', async (req, res, next) => {
  try {
    const p = await ProductService.getProductBySku(req.tenantId, req.params.sku);
    if (!p) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json({ ok: true, product: p });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/',
  validate({
    sku: { required: true, type: 'string' },
    title: { required: true, type: 'string' }
  }),
  async (req, res, next) => {
    try {
      res.json({ ok: true, product: await ProductService.upsertProduct(req.tenantId, req.body) });
    } catch (e) {
      next(e);
    }
  }
);

router.post('/bulk', async (req, res, next) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || !products.length) {
      return res.status(400).json({ error: 'products[] requis' });
    }
    res.json({ ok: true, ...(await ProductService.bulkImport(req.tenantId, products)) });
  } catch (e) {
    next(e);
  }
});

router.delete('/:sku', async (req, res, next) => {
  try {
    await ProductService.deleteProduct(req.tenantId, req.params.sku);
    res.json({ ok: true, deleted: req.params.sku });
  } catch (e) {
    next(e);
  }
});

module.exports = router;