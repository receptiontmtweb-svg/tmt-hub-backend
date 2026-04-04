'use strict';
/**
 * db/credentials-store.js — Stockage sécurisé credentials marketplace
 *
 * Chiffrement AES-256-GCM côté serveur.
 * La clé CRED_ENCRYPTION_KEY ne quitte jamais le backend.
 * Jamais exposé au frontend.
 */

const crypto = require('crypto');
const { getDB } = require('./database');
const Logger = require('../utils/logger');

const ALGO   = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

// ── Crypto ────────────────────────────────────────────────────
function _deriveKey(tenantId) {
  const secret = process.env.CRED_ENCRYPTION_KEY;
  if (!secret || secret.length < 32)
    throw new Error('CRED_ENCRYPTION_KEY manquante ou < 32 chars');
  return crypto.createHash('sha256').update(`${secret}:${tenantId}`).digest();
}

function encrypt(data, tenantId) {
  const key = _deriveKey(tenantId);
  const iv  = crypto.randomBytes(IV_LEN);
  const c   = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(encoded, tenantId) {
  const key = _deriveKey(tenantId);
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('Payload chiffré invalide');
  const d = crypto.createDecipheriv(ALGO, key, buf.slice(0, IV_LEN));
  d.setAuthTag(buf.slice(IV_LEN, IV_LEN + TAG_LEN));
  return JSON.parse(Buffer.concat([d.update(buf.slice(IV_LEN + TAG_LEN)), d.final()]).toString('utf8'));
}

function selfTest() {
  const orig = { test: 'tmt-v14', ts: Date.now() };
  if (decrypt(encrypt(orig, 'test'), 'test').test !== orig.test)
    throw new Error('Credentials store self-test échoué');
}

// ── Token cache (mémoire, TTL 50 min) ────────────────────────
const _tokenCache = new Map();

const TokenCache = {
  set(mp, tenantId, token, ttl = 3500) {
    _tokenCache.set(`${mp}:${tenantId}`, { token, exp: Date.now() + ttl * 1000 });
  },
  get(mp, tenantId) {
    const e = _tokenCache.get(`${mp}:${tenantId}`);
    if (!e) return null;
    if (Date.now() > e.exp) { _tokenCache.delete(`${mp}:${tenantId}`); return null; }
    return e.token;
  },
  invalidate(mp, tenantId) { _tokenCache.delete(`${mp}:${tenantId}`); },
  invalidateAll(tenantId)  {
    for (const k of _tokenCache.keys()) if (k.endsWith(`:${tenantId}`)) _tokenCache.delete(k);
  },
};

// ── CredentialStore ───────────────────────────────────────────
const CredentialStore = {
  /**
   * Sauvegarder des credentials chiffrés
   * @param {string} tenantId
   * @param {string} marketplace  — 'amazon' | 'cdiscount' | 'ebay' | ...
   * @param {object} creds        — credentials bruts (NE JAMAIS logger)
   */
  async save(tenantId, marketplace, creds) {
    const db = getDB();
    const payload = encrypt(creds, tenantId);
    await db.upsert('marketplace_accounts', {
      company_id:  tenantId,
      marketplace,
      credentials: payload,
      is_active:   true,
      updated_at:  new Date().toISOString(),
    }, 'company_id,marketplace');
    TokenCache.invalidate(marketplace, tenantId);
    Logger.audit('CREDENTIALS_SAVED', tenantId, { marketplace });
  },

  /**
   * Charger et déchiffrer des credentials
   * @returns {object|null}
   */
  async load(tenantId, marketplace) {
    const db  = getDB();
    const row = await db.findOne('marketplace_accounts', { company_id: tenantId, marketplace, is_active: true });
    if (!row?.credentials) return null;
    return decrypt(row.credentials, tenantId);
  },

  /** Supprimer des credentials */
  async remove(tenantId, marketplace) {
    const db = getDB();
    await db.update('marketplace_accounts', { company_id: tenantId, marketplace }, { is_active: false });
    TokenCache.invalidate(marketplace, tenantId);
    Logger.audit('CREDENTIALS_REMOVED', tenantId, { marketplace });
  },

  /** Lister les marketplaces configurées (sans exposer les credentials) */
  async listConfigured(tenantId) {
    const db   = getDB();
    const rows = await db.findMany('marketplace_accounts', { company_id: tenantId, is_active: true });
    return rows.map(r => ({
      marketplace: r.marketplace,
      updated_at:  r.updated_at,
      has_creds:   !!r.credentials,
    }));
  },

  async isConfigured(tenantId, marketplace) {
    const db  = getDB();
    const row = await db.findOne('marketplace_accounts', { company_id: tenantId, marketplace, is_active: true });
    return !!row?.credentials;
  },

  selfTest,
};

module.exports = { CredentialStore, TokenCache, encrypt, decrypt };
