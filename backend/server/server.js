'use strict';

require('dotenv').config();
console.log('DEBUG AMZ_SANDBOX =', process.env.AMZ_SANDBOX);

/**
 * backend/server/server.js — Point d'entrée TMT HUB v14
 *
 * Démarre Express, monte toutes les routes, démarre le worker de queue.
 * Compatible Vercel (export module.exports = app) et VPS (app.listen).
 */

const express = require('express');
const Logger  = require('../utils/logger');

// ── Validation config au démarrage ───────────────────────────
function validateConfig() {
  const required = ['TMT_MASTER_KEY', 'CRED_ENCRYPTION_KEY'];
  const missing  = required.filter(k => !process.env[k] || process.env[k].length < 32);
  if (missing.length && process.env.NODE_ENV === 'production') {
    Logger.error('server', 'CONFIG_MISSING', { missing });
    process.exit(1);
  } else if (missing.length) {
    Logger.warn('server', 'CONFIG_MISSING_DEV', { missing, note: 'OK en dev — non acceptable en prod' });
  }
}

// ── Créer l'app ───────────────────────────────────────────────
function createApp() {
  validateConfig();
  const app = express();

  // ── Body parsing ──────────────────────────────────────────
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false }));

  // ── CORS ──────────────────────────────────────────────────
  app.use((req, res, next) => {
    const origins  = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
    const origin   = req.headers.origin || '';
    const allowAll = origins.includes('*');
    if (allowAll || origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin',  allowAll ? '*' : origin);
    }
    res.setHeader('Access-Control-Allow-Methods',  'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',  'Content-Type,Authorization,X-TMT-Key,X-TMT-Tenant');
    res.setHeader('Access-Control-Max-Age',        '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // ── Security headers ──────────────────────────────────────
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options',        'DENY');
    res.setHeader('X-XSS-Protection',       '1; mode=block');
    res.setHeader('Referrer-Policy',        'no-referrer');
    next();
  });

  // ── Request logger ────────────────────────────────────────
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => Logger.request(req, res, Date.now() - t0));
    next();
  });

  // ── Health (sans auth) ────────────────────────────────────
  app.get('/api/health', (req, res) => {
    res.json({
      status:  'ok',
      version: '14.0.0',
      ts:      new Date().toISOString(),
      node:    process.version,
      env:     process.env.NODE_ENV || 'development',
      sandbox: {
        amazon:  process.env.AMZ_SANDBOX      === 'true',
        octopia: process.env.OCTOPIA_SANDBOX  === 'true',
      },
      store:   process.env.SUPABASE_URL ? 'supabase' : 'memory',
      connectors: ['amazon-sp-api', 'octopia-cdiscount', 'ebay', 'rakuten', 'wix', 'fnac'],
    });
  });

  // ── Routes ────────────────────────────────────────────────
  app.use('/api/credentials', require('../routes/credentials'));
  app.use('/api/relay',       require('../routes/relay'));
  app.use('/api/amazon',      require('../routes/amazon'));
  app.use('/api/octopia',     require('../routes/octopia'));
  app.use('/api/transport',   require('../routes/transport'));
  app.use('/api/orders',      require('../routes/orders'));
  app.use('/api/products',    require('../routes/products'));
  app.use('/api/queue',       require('../routes/queue'));
  app.use('/api/packlink',    require('../routes/packlink'));
  // app.use('/api/packlink',    require('../routes/packlink'));
  

  // ── 404 ───────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({ error: `Route non trouvée: ${req.method} ${req.path}` });
  });

  // ── Error handler global ──────────────────────────────────
  app.use((err, req, res, _next) => {
    Logger.error('server', 'UNHANDLED', { path: req.path, error: err.message, stack: err.stack?.slice(0, 300) });
    const status  = err.status || err.statusCode || 500;
    const message = (process.env.NODE_ENV === 'production' && status >= 500)
      ? 'Internal Server Error'
      : err.message;
    if (!res.headersSent) res.status(status).json({ error: message });
  });

  return app;
}

// ── Enregistrer les handlers de queue ────────────────────────
function registerQueueHandlers() {
  const SyncQueue      = require('../queue/sync-queue');
  const OrderService   = require('../services/order-service');
  const StockService   = require('../services/stock-service');

  SyncQueue.register('sync_orders',   ({ tenantId, payload }) => OrderService.syncOrders(tenantId, payload.marketplace, payload));
  SyncQueue.register('sync_stock',    ({ tenantId, payload }) => StockService.syncStock(tenantId, payload.marketplace));
  SyncQueue.register('sync_products', ({ tenantId, payload }) => {
    Logger.info('queue', 'sync_products — à implémenter', { tenantId });
    return { ok: true };
  });
}

// ── Démarrage ─────────────────────────────────────────────────
const app = createApp();
registerQueueHandlers();

// En dehors de Vercel/serverless : démarrer le serveur HTTP
if (process.env.VERCEL !== '1' && require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    Logger.info('server', 'STARTED', {
      port:    PORT,
      env:     process.env.NODE_ENV || 'development',
      db:      process.env.SUPABASE_URL ? 'supabase' : 'memory',
      sandbox: { amazon: process.env.AMZ_SANDBOX === 'true', octopia: process.env.OCTOPIA_SANDBOX === 'true' },
    });
    // Démarrer le worker de queue
    require('../queue/sync-queue').startWorker();
  });
}

module.exports = app;  // Pour Vercel serverless + tests
