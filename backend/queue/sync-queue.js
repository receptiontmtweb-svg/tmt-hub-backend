'use strict';
/**
 * queue/sync-queue.js — File de synchronisation asynchrone
 *
 * Architecture légère en mémoire (compatible mono-instance).
 * En SaaS multi-tenant : remplacer par BullMQ + Redis / Upstash.
 *
 * Types de jobs :
 *   sync_orders   — récupérer commandes depuis marketplace
 *   sync_stock    — récupérer stocks depuis marketplace
 *   sync_products — récupérer catalogue depuis marketplace
 *   update_stock  — pousser stock vers marketplace
 *   confirm_ship  — confirmer expédition
 */

const { getDB } = require('../db/database');
const Logger    = require('../utils/logger');

const JOB_STATUS = { PENDING: 'pending', RUNNING: 'running', DONE: 'done', FAILED: 'failed', RETRY: 'retry' };
const MAX_RETRIES = 3;
const RETRY_DELAYS = [5_000, 30_000, 120_000]; // 5s, 30s, 2min

// Queue en mémoire — tableau circulaire simple
const _queue     = [];
let   _running   = false;
let   _workerInterval = null;

// Registre des handlers
const _handlers  = {};

const SyncQueue = {
  JOB_STATUS,

  /**
   * Enregistrer un handler pour un type de job
   * @param {string} type
   * @param {Function} handler async (payload) => result
   */
  register(type, handler) {
    _handlers[type] = handler;
    Logger.info('sync-queue', 'HANDLER_REGISTERED', { type });
  },

  /**
   * Enqueuer un job
   * @param {string} type
   * @param {string} tenantId
   * @param {object} payload
   * @param {object} opts — { priority: 'high'|'normal'|'low', delay: ms }
   * @returns {string} jobId
   */
  async enqueue(type, tenantId, payload = {}, opts = {}) {
    const db = getDB();
    const job = {
      type,
      company_id:  tenantId,
      payload:     JSON.stringify(payload),
      status:      JOB_STATUS.PENDING,
      priority:    opts.priority || 'normal',
      attempts:    0,
      max_attempts: MAX_RETRIES,
      scheduled_at: new Date(Date.now() + (opts.delay || 0)).toISOString(),
      created_at:  new Date().toISOString(),
    };

    const record = await db.insert('sync_jobs', job);
    Logger.info('sync-queue', 'JOB_ENQUEUED', { type, tenantId, jobId: record.id });

    // Démarrer le worker si pas déjà actif
    SyncQueue.startWorker();
    return record.id;
  },

  /**
   * Traiter un job immédiatement (mode synchrone pour les routes API)
   */
  async runNow(type, tenantId, payload = {}) {
    const handler = _handlers[type];
    if (!handler) throw new Error(`Handler non trouvé pour le type: ${type}`);

    const t0 = Date.now();
    try {
      const result = await handler({ tenantId, payload });
      Logger.info('sync-queue', 'JOB_DONE', { type, tenantId, duration_ms: Date.now() - t0 });
      return { ok: true, result };
    } catch(e) {
      Logger.error('sync-queue', 'JOB_FAIL', { type, tenantId, error: e.message });
      throw e;
    }
  },

  /** Worker — traite un job à la fois */
  async _processOne() {
    if (_running) return;
    _running = true;

    const db = getDB();
    let job  = null;

    try {
      // Prendre le prochain job en attente (priorité: high > normal > low)
      const pending = await db.findMany('sync_jobs', { status: JOB_STATUS.PENDING }, {
        order: 'created_at', asc: true, limit: 1,
      });
      job = pending[0];
      if (!job) return;

      // Vérifier la date d'exécution planifiée
      if (job.scheduled_at && new Date(job.scheduled_at) > new Date()) return;

      // Marquer comme en cours
      await db.update('sync_jobs', { id: job.id }, { status: JOB_STATUS.RUNNING, started_at: new Date().toISOString() });

      const handler = _handlers[job.type];
      if (!handler) {
        await db.update('sync_jobs', { id: job.id }, { status: JOB_STATUS.FAILED, error: `Handler ${job.type} introuvable` });
        return;
      }

      const t0     = Date.now();
      const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      const result  = await handler({ tenantId: job.company_id, payload });

      await db.update('sync_jobs', { id: job.id }, {
        status:      JOB_STATUS.DONE,
        result:      JSON.stringify(result),
        duration_ms: Date.now() - t0,
        finished_at: new Date().toISOString(),
      });
      Logger.info('sync-queue', 'JOB_DONE', { type: job.type, jobId: job.id, duration_ms: Date.now() - t0 });

    } catch(e) {
      if (!job) return;
      const attempts = (job.attempts || 0) + 1;
      const isFinal  = attempts >= MAX_RETRIES;
      const delay    = RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];

      await db.update('sync_jobs', { id: job.id }, {
        status:       isFinal ? JOB_STATUS.FAILED : JOB_STATUS.RETRY,
        attempts,
        error:        e.message,
        scheduled_at: isFinal ? null : new Date(Date.now() + delay).toISOString(),
      });

      if (isFinal) Logger.error('sync-queue', 'JOB_FAILED_FINAL', { type: job.type, jobId: job.id, error: e.message });
      else         Logger.warn('sync-queue', 'JOB_RETRY', { type: job.type, jobId: job.id, attempt: attempts, delay });

    } finally {
      _running = false;
    }
  },

  /** Démarrer le worker polling */
  startWorker(intervalMs = 5_000) {
    if (_workerInterval) return;
    _workerInterval = setInterval(() => SyncQueue._processOne().catch(() => {}), intervalMs);
    Logger.info('sync-queue', 'WORKER_STARTED', { interval_ms: intervalMs });
  },

  stopWorker() {
    if (_workerInterval) { clearInterval(_workerInterval); _workerInterval = null; }
  },

  /** Statut de la queue */
  async getStats(tenantId) {
    const db = getDB();
    const jobs = await db.findMany('sync_jobs', { company_id: tenantId });
    return {
      total:   jobs.length,
      pending: jobs.filter(j => j.status === JOB_STATUS.PENDING).length,
      running: jobs.filter(j => j.status === JOB_STATUS.RUNNING).length,
      done:    jobs.filter(j => j.status === JOB_STATUS.DONE).length,
      failed:  jobs.filter(j => j.status === JOB_STATUS.FAILED).length,
      retry:   jobs.filter(j => j.status === JOB_STATUS.RETRY).length,
    };
  },

  /** Historique des jobs */
  async getJobs(tenantId, filters = {}, limit = 50) {
    const db = getDB();
    const dbFilters = { company_id: tenantId };
    if (filters.status) dbFilters.status = filters.status;
    if (filters.type)   dbFilters.type   = filters.type;
    return db.findMany('sync_jobs', dbFilters, { order: 'created_at', asc: false, limit });
  },
};

module.exports = SyncQueue;
