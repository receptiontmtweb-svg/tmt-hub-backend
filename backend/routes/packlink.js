'use strict';

const express = require('express');
const router = express.Router();

const fetchFn = (...args) => globalThis.fetch(...args);

const PACKLINK_BASE = 'https://api.packlink.com/pro';

const { requireAuth } = require('../middleware/auth');
router.use(requireAuth);

// ─────────────────────────────
// 🧰 Helper réponse HTTP
// ─────────────────────────────
async function parsePacklinkResponse(r) {
  const text = await r.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return {
    ok: r.ok,
    status: r.status,
    data
  };
}

// ─────────────────────────────
// 🧪 TEST API
// Endpoint réel observé dans Packlink : /pro/init
// ─────────────────────────────
router.post('/test', async (req, res) => {
  try {
    const apiKey = process.env.PACKLINK_API_KEY;

    const r = await fetchFn(`${PACKLINK_BASE}/init`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json, text/plain, */*'
      }
    });

    const result = await parsePacklinkResponse(r);
    return res.json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────
// 📦 CRÉATION EXPÉDITION
// ─────────────────────────────
router.post('/create', async (req, res) => {
  try {
    const apiKey = process.env.PACKLINK_API_KEY;
    const payload = req.body || {};

    const r = await fetchFn(`${PACKLINK_BASE}/shipments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*'
      },
      body: JSON.stringify(payload)
    });

    const result = await parsePacklinkResponse(r);
    return res.json(result);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;