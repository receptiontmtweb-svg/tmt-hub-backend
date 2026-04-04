'use strict';
/**
 * routes/amazon.js — Routes Amazon SP-API
 */
const express         = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate, rateLimit } = require('../middleware/validation');
const { CredentialStore, TokenCache } = require('../db/credentials-store');
const AmazonConnector = require('../connectors/amazon-connector');
const OrderService    = require('../services/order-service');
const StockService    = require('../services/stock-service');
const Logger          = require('../utils/logger');

const router = express.Router();
router.use(requireAuth, rateLimit(30));

async function getToken(req) {
  const { tenantId } = req;
  const cached = TokenCache.get('amazon', tenantId);
  if (cached) return cached;
  let creds = req.body?.credentials;
  if (!creds) creds = await CredentialStore.load(tenantId, 'amazon');
  if (!creds?.client_id) throw Object.assign(new Error('Credentials Amazon non configurés'), { status: 401 });
  const token = await AmazonConnector.getToken(creds);
  TokenCache.set('amazon', tenantId, token, 3500);
  return token;
}

router.post('/test',      async (req, res, next) => { try { const creds = await CredentialStore.load(req.tenantId,'amazon'); const r = await AmazonConnector.testConnection(creds||req.body); res.json(r); } catch(e) { next(e); } });
router.post('/sync',      async (req, res, next) => { try { const r = await OrderService.syncOrders(req.tenantId,'amazon',req.body); res.json({ok:true,...r}); } catch(e) { next(e); } });
router.post('/inventory', async (req, res, next) => { try { const tok=await getToken(req); const r=await AmazonConnector.getInventory(tok,req.body); res.json({ok:true,...r}); } catch(e) { next(e); } });
router.post('/stock',     validate({ sellerId:{required:true,type:'string'}, sku:{required:true,type:'string'}, quantity:{required:true,type:'number',min:0} }), async (req,res,next) => { try { const {sellerId,sku,quantity,mpId}=req.body; const tok=await getToken(req); const r=await AmazonConnector.updateStock(tok,sellerId,sku,quantity,mpId); Logger.audit('STOCK_UPDATED',req.tenantId,{marketplace:'amazon',sku,quantity}); res.json({ok:true,...r}); } catch(e){next(e);} });
router.post('/price',     validate({ sellerId:{required:true,type:'string'}, sku:{required:true,type:'string'}, price:{required:true,type:'number',min:0.01} }), async (req,res,next) => { try { const {sellerId,sku,price,mpId}=req.body; const tok=await getToken(req); const r=await AmazonConnector.updatePrice(tok,sellerId,sku,price,mpId); res.json({ok:true,...r}); } catch(e){next(e);} });
router.post('/ship',      validate({ orderId:{required:true,type:'string'}, trackingNumber:{required:true,type:'string',minLength:5}, items:{required:true,type:'array'} }), async (req,res,next) => { try { const tok=await getToken(req); const r=await AmazonConnector.confirmShipment(tok,req.body); res.json({ok:true,...r}); } catch(e){next(e);} });
router.post('/report',    async (req, res, next) => { try { const tok=await getToken(req); const r=await AmazonConnector.requestReport(tok,req.body.reportType,req.body.mpId); res.json({ok:true,...r}); } catch(e){next(e);} });
router.post('/catalog',   async (req, res, next) => { try { const tok=await getToken(req); const r=await AmazonConnector.getCatalogItem(tok,req.body); res.json({ok:true,data:r}); } catch(e){next(e);} });

router.get('/health', (req, res) => {
  res.json({ ok: true, route: 'amazon' });
});

module.exports = router;
