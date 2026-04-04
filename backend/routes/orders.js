'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/validation');
const OrderService = require('../services/order-service');

const router = express.Router();
router.use(requireAuth, rateLimit(60));

router.get('/', async (req, res, next) => {
  try {
    const { marketplace, status, page, pageSize } = req.query;

    const result = await OrderService.getOrders(
      req.tenantId,
      { marketplace, status },
      { page: +page || 1, pageSize: +pageSize || 50 }
    );

    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

router.get('/health', (req, res) => {
  res.json({ ok: true, route: 'orders' });
});

module.exports = router;