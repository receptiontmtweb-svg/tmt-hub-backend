'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/validation');
const { CredentialStore } = require('../db/credentials-store');
const TransportRouter = require('../connectors/transport-router');

const router = express.Router();
router.use(requireAuth, rateLimit(30));

async function resolveTransportCredentials(tenantId, carrierId, credentials) {
  if (credentials && Object.keys(credentials).length > 0) {
    return credentials;
  }

  // suppose que CredentialStore.get existe déjà
  const stored = await CredentialStore.load(tenantId, `transport_${carrierId}`);
  return stored || {};
}

router.get('/health', (req, res) => {
  res.json({ ok: true, route: 'transport' });
});

router.get('/carriers', (req, res) => {
  res.json({ ok: true, carriers: TransportRouter.getCarriers() });
});

// sauvegarde des credentials transport côté serveur
router.post('/credentials', async (req, res, next) => {
  try {
    const { carrierId, ...creds } = req.body;

    if (!carrierId) {
      return res.status(400).json({ error: 'carrierId requis' });
    }

    await CredentialStore.save(req.tenantId, `transport_${carrierId}`, creds);

    res.json({
      ok: true,
      saved: carrierId,
      type: 'transport',
    });
  } catch (e) {
    next(e);
  }
});

router.post('/test', async (req, res, next) => {
  try {
    const { carrierId, credentials } = req.body;

    if (!carrierId) {
      return res.status(400).json({ error: 'carrierId requis' });
    }

    const creds = await resolveTransportCredentials(req.tenantId, carrierId, credentials);
    const result = await TransportRouter.testConnection(carrierId, creds);

    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

router.post('/label', async (req, res, next) => {
  try {
    const { carrierId, credentials, shipment } = req.body;

    if (!carrierId) {
      return res.status(400).json({ error: 'carrierId requis' });
    }

    const creds = await resolveTransportCredentials(req.tenantId, carrierId, credentials);
    const result = await TransportRouter.generateLabel(
      carrierId,
      creds,
      shipment || {}
    );

    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

router.post('/tracking', async (req, res, next) => {
  try {
    const { carrierId, trackingNumber, credentials } = req.body;

    if (!carrierId) {
      return res.status(400).json({ error: 'carrierId requis' });
    }

    const creds = await resolveTransportCredentials(req.tenantId, carrierId, credentials);
    const result = await TransportRouter.getTracking(
      carrierId,
      trackingNumber,
      creds
    );

    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

router.post('/pickup-points', async (req, res, next) => {
  try {
    const { carrierId, options } = req.body;

    if (!carrierId) {
      return res.status(400).json({ error: 'carrierId requis' });
    }

    const result = await TransportRouter.getPickupPoints(
      carrierId,
      options || {}
    );

    res.json({ ok: true, ...result });
  } catch (e) {
    next(e);
  }
});

module.exports = router;