'use strict';
/**
 * routes/credentials.js — CRUD credentials marketplace (serveur uniquement)
 */
const express          = require('express');
const { requireAuth }  = require('../middleware/auth');
const { rateLimit, validate } = require('../middleware/validation');
const { CredentialStore }     = require('../db/credentials-store');
const Logger           = require('../utils/logger');

const router = express.Router();
router.use(requireAuth, rateLimit(20));

// POST /api/credentials — sauvegarder
router.post('/',
  validate({ marketplace: { required: true, type: 'string' } }),
  async (req, res, next) => {
    try {
      const { marketplace, ...creds } = req.body;
      await CredentialStore.save(req.tenantId, marketplace, creds);
      res.json({ ok: true, saved: marketplace });
    } catch(e) { next(e); }
  }
);

// GET /api/credentials — lister (sans credentials)
router.get('/', async (req, res, next) => {
  try {
    const list = await CredentialStore.listConfigured(req.tenantId);
    res.json({ ok: true, configured: list });
  } catch(e) { next(e); }
});

// GET /api/credentials/:marketplace/status — vérifier si configuré
router.get('/:marketplace/status', async (req, res, next) => {
  try {
    const ok = await CredentialStore.isConfigured(req.tenantId, req.params.marketplace);
    res.json({ ok, marketplace: req.params.marketplace, configured: ok });
  } catch(e) { next(e); }
});

// DELETE /api/credentials/:marketplace — supprimer
router.delete('/:marketplace', async (req, res, next) => {
  try {
    await CredentialStore.remove(req.tenantId, req.params.marketplace);
    res.json({ ok: true, deleted: req.params.marketplace });
  } catch(e) { next(e); }
});

module.exports = router;
