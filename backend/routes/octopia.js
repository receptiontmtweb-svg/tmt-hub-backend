'use strict';
/**
 * routes/octopia.js — Routes Octopia / Cdiscount
 */
const express          = require('express');
const { requireAuth }  = require('../middleware/auth');
const { validate, rateLimit } = require('../middleware/validation');
const { CredentialStore, TokenCache } = require('../db/credentials-store');
const OctopiaConnector = require('../connectors/octopia-connector');
const OrderService     = require('../services/order-service');
const Logger           = require('../utils/logger');

const router = express.Router();
router.use(requireAuth, rateLimit(30));

async function getToken(req) {
  const { tenantId } = req;
  const cached = TokenCache.get('cdiscount', tenantId);
  if (cached) return cached;

  let creds = req.body?.credentials;
  if (!creds) creds = await CredentialStore.load(tenantId, 'cdiscount');

  if (!creds?.client_id || !creds?.client_secret) {
    throw Object.assign(new Error('Credentials Octopia non configurés'), { status: 401 });
  }

  const token = await OctopiaConnector.getToken(creds);
  TokenCache.set('cdiscount', tenantId, token, 3500);
  return token;
}

router.post('/test',       async (req,res,next) => { try { const creds=await CredentialStore.load(req.tenantId,'cdiscount'); const r=await OctopiaConnector.testConnection(creds||req.body); res.json(r); } catch(e){next(e);} });
router.post('/sync',       async (req,res,next) => { try { const r=await OrderService.syncOrders(req.tenantId,'cdiscount',req.body); res.json({ok:true,...r}); } catch(e){next(e);} });
router.post('/stock',      validate({offers:{required:true,type:'array'}}), async (req,res,next) => { try { const tok=await getToken(req); const r=await OctopiaConnector.updateStock(tok,req.body.offers); Logger.audit('STOCK_UPDATED',req.tenantId,{marketplace:'cdiscount',count:req.body.offers.length}); res.json({ok:true,...r}); } catch(e){next(e);} });
router.post('/prices',     validate({offers:{required:true,type:'array'}}), async (req,res,next) => { try { const tok=await getToken(req); const r=await OctopiaConnector.updatePrices(tok,req.body.offers); res.json({ok:true,...r}); } catch(e){next(e);} });
router.post('/ship',       validate({orderNumber:{required:true,type:'string'},trackingNumber:{required:true,type:'string',minLength:5}}), async (req,res,next) => { try { const tok=await getToken(req); const r=await OctopiaConnector.confirmShipment(tok,req.body); res.json({ok:true,...r}); } catch(e){next(e);} });
router.post('/offers',     async (req,res,next) => { try { const tok=await getToken(req); const r=await OctopiaConnector.getOffers(tok,req.body); res.json({ok:true,count:r.length,data:r}); } catch(e){next(e);} });
router.post('/offer',      validate({offer:{required:true}}), async (req,res,next) => { try { const tok=await getToken(req); const r=await OctopiaConnector.upsertOffer(tok,req.body.offer); res.json({ok:true,data:r}); } catch(e){next(e);} });
router.post('/products',   async (req,res,next) => { try { const tok=await getToken(req); const r=await OctopiaConnector.getProducts(tok,req.body); res.json({ok:true,count:r.length,data:r}); } catch(e){next(e);} });

router.get('/health', (req, res) => {
  res.json({ ok: true, route: 'octopia' });
});

module.exports = router;
