'use strict';
/**
 * routes/relay.js — Proxy CORS-safe vers APIs marketplace
 */
const express         = require('express');
const { requireAuth } = require('../middleware/auth');
const { rateLimit }   = require('../middleware/validation');
const Logger          = require('../utils/logger');

const router = express.Router();
router.use(requireAuth, rateLimit(120));

const ALLOWED_DOMAINS = new Set([
  'sellingpartnerapi-eu.amazon.com', 'sellingpartnerapi-na.amazon.com',
  'sandbox.sellingpartnerapi-eu.amazon.com', 'api.amazon.com',
  'seller-api.octopia.com', 'seller-api.sandbox.octopia.com',
  'api.ebay.com', 'api.sandbox.ebay.com',
  'ws.fr.shopping.rakuten.com', 'www.wixapis.com',
  'www.fnac-marketplace.com', 'sandbox.fnac-marketplace.com',
]);
const SAFE_PROTO   = new Set(['https:']);
const SAFE_METHODS = new Set(['GET','POST','PUT','PATCH','DELETE']);
const BLOCK_HDRS   = new Set(['host','x-tmt-key','x-tmt-tenant','cookie','set-cookie']);

router.post('/', async (req, res, next) => {
  const { mp, method, url, headers = {}, body } = req.body;
  if (!url || !method) return res.status(400).json({ error: 'url et method requis' });

  let u;
  try { u = new URL(url); } catch(e) { return res.status(400).json({ error: 'URL invalide' }); }
  if (!SAFE_PROTO.has(u.protocol))      return res.status(400).json({ error: `Protocole non autorisé: ${u.protocol}` });
  if (!ALLOWED_DOMAINS.has(u.hostname)) { Logger.warn('relay','BLOCKED',{hostname:u.hostname}); return res.status(403).json({ error: `Domaine non autorisé: ${u.hostname}` }); }
  if (!SAFE_METHODS.has(method.toUpperCase())) return res.status(400).json({ error: `Méthode non autorisée: ${method}` });

  const clean = Object.fromEntries(Object.entries(headers).filter(([k]) => !BLOCK_HDRS.has(k.toLowerCase())));
  clean['User-Agent'] = 'TMT-HUB/14.0';

  try {
    Logger.info('relay', `${method} ${u.hostname}${u.pathname}`);
    const upstream = await fetch(url, { method: method.toUpperCase(), headers: clean, body: body || undefined });
    const ct = upstream.headers.get('content-type') || '';
    let data;
    if (ct.includes('json'))             data = await upstream.json();
    else if (ct.includes('text')||ct.includes('xml')) data = { raw: await upstream.text(), contentType: ct };
    else { const buf = await upstream.arrayBuffer(); data = { base64: Buffer.from(buf).toString('base64'), contentType: ct }; }
    res.status(upstream.status).json(data);
  } catch(e) { next(e); }
});

module.exports = router;
