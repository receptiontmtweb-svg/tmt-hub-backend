'use strict';
const express          = require('express');
const { requireAuth }  = require('../middleware/auth');
const { rateLimit }    = require('../middleware/validation');
const SyncQueue        = require('../queue/sync-queue');

const router = express.Router();
router.use(requireAuth, rateLimit(30));

router.get('/stats', async (req, res, next) => { try { res.json({ ok: true, stats: await SyncQueue.getStats(req.tenantId) }); } catch(e) { next(e); } });
router.get('/jobs',  async (req, res, next) => { try { const { status, type, limit } = req.query; res.json({ ok: true, jobs: await SyncQueue.getJobs(req.tenantId, { status, type }, +limit||50) }); } catch(e) { next(e); } });
router.post('/enqueue', async (req, res, next) => { try { const { type, payload, priority, delay } = req.body; if (!type) return res.status(400).json({ error: 'type requis' }); const jobId = await SyncQueue.enqueue(type, req.tenantId, payload||{}, { priority, delay }); res.json({ ok: true, jobId }); } catch(e) { next(e); } });

router.get('/health', (req, res) => {
  res.json({ ok: true, route: 'queue' });
});


module.exports = router;
