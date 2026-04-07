'use strict';

/**
 * db/credentials-store.js
 * Stockage des credentials marketplace via Supabase (tmt_hub_data)
 * Fallback mémoire si Supabase non configuré
 */

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ENC_KEY      = process.env.CRED_ENCRYPTION_KEY || '';
const TABLE        = 'tmt_hub_data';

// ── Chiffrement AES-256-GCM ───────────────────────────────────
function _encKey() {
  if (!ENC_KEY) return null;
  return crypto.createHash('sha256').update(ENC_KEY).digest();
}

function encrypt(text) {
  const key = _encKey();
  if (!key) return text; // pas de chiffrement si pas de clé
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(text) {
  try {
    const key = _encKey();
    if (!key || !text.includes(':')) return text;
    const [ivHex, tagHex, encHex] = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
  } catch {
    return text; // retourne tel quel si déchiffrement échoue
  }
}

// ── Supabase fetch helper ─────────────────────────────────────
async function _sb(method, path, body) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return null;
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// ── Mémoire fallback ──────────────────────────────────────────
const _mem = new Map();

// ── CredentialStore ───────────────────────────────────────────
const CredentialStore = {

  async save(tenantId, marketplace, creds) {
    const id  = `cred:${tenantId}:${marketplace}`;
    const enc = encrypt(JSON.stringify(creds));

    // Supabase
    if (SUPABASE_URL) {
      await _sb('POST', TABLE, {
        id,
        data:       { encrypted: enc, marketplace, tenantId },
        updated_at: new Date().toISOString(),
      });
    }

    // Mémoire toujours
    _mem.set(id, creds);
    return true;
  },

  async load(tenantId, marketplace) {
    const id = `cred:${tenantId}:${marketplace}`;

    // Mémoire d'abord
    if (_mem.has(id)) return _mem.get(id);

    // Supabase
    if (SUPABASE_URL) {
      const rows = await _sb('GET', `${TABLE}?id=eq.${encodeURIComponent(id)}&select=data`);
      if (rows && rows[0]?.data?.encrypted) {
        try {
          const creds = JSON.parse(decrypt(rows[0].data.encrypted));
          _mem.set(id, creds); // cache mémoire
          return creds;
        } catch { return null; }
      }
    }

    return null;
  },

  async remove(tenantId, marketplace) {
    const id = `cred:${tenantId}:${marketplace}`;
    _mem.delete(id);
    if (SUPABASE_URL) {
      await _sb('DELETE', `${TABLE}?id=eq.${encodeURIComponent(id)}`, null);
    }
    return true;
  },

  async listConfigured(tenantId) {
    const prefix = `cred:${tenantId}:`;
    const local  = [..._mem.keys()]
      .filter(k => k.startsWith(prefix))
      .map(k => k.replace(prefix, ''));

    if (SUPABASE_URL) {
      const rows = await _sb('GET', `${TABLE}?id=like.cred:${tenantId}:%&select=id,data`);
      if (rows) {
        return rows.map(r => r.data?.marketplace || r.id.replace(prefix, ''));
      }
    }

    return local;
  },

  async isConfigured(tenantId, marketplace) {
    const creds = await this.load(tenantId, marketplace);
    return !!creds;
  },
};

// ── TokenCache (en mémoire uniquement) ───────────────────────
const _tokenCache = new Map();

const TokenCache = {
  get(marketplace, tenantId) {
    const k = `${marketplace}:${tenantId}`;
    const e = _tokenCache.get(k);
    if (!e) return null;
    if (Date.now() > e.exp) { _tokenCache.delete(k); return null; }
    return e.token;
  },
  set(marketplace, tenantId, token, ttlSeconds = 3500) {
    _tokenCache.set(`${marketplace}:${tenantId}`, {
      token,
      exp: Date.now() + ttlSeconds * 1000,
    });
  },
  delete(marketplace, tenantId) {
    _tokenCache.delete(`${marketplace}:${tenantId}`);
  },
};

module.exports = { CredentialStore, TokenCache };