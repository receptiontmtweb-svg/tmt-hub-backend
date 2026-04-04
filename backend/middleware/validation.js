'use strict';
/**
 * middleware/validation.js — Validation + Rate limiting
 */

const Logger = require('../utils/logger');

// ── Rate limiter en mémoire ───────────────────────────────────
const _buckets = new Map();

function rateLimit(maxReq = 60, windowMs = 60_000) {
  return (req, res, next) => {
    const ip  = (req.headers['x-forwarded-for'] || req.ip || '127.0.0.1').split(',')[0].trim();
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    let b = _buckets.get(key);
    if (!b || now > b.reset) b = { count: 0, reset: now + windowMs };
    b.count++;
    _buckets.set(key, b);

    if (_buckets.size > 10_000) {
      for (const [k, v] of _buckets) if (now > v.reset) _buckets.delete(k);
    }

    res.setHeader('X-RateLimit-Limit',     maxReq);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxReq - b.count));
    res.setHeader('X-RateLimit-Reset',     Math.ceil(b.reset / 1000));

    if (b.count > maxReq) {
      Logger.warn('ratelimit', 'EXCEEDED', { ip, path: req.path });
      return res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: Math.ceil((b.reset - now) / 1000),
      });
    }
    next();
  };
}

// ── Validator de body ─────────────────────────────────────────
/**
 * Schéma : { field: { required?, type?, minLength?, min?, max?, enum? } }
 * Usage : validate({ sku: { required: true, type: 'string' } })
 */
function validate(schema) {
  return (req, res, next) => {
	  
	  if (!schema || typeof schema !== 'object') {
  return next();
}
	  
    const errors = [];
    const body   = req.body || {};

    for (const [field, rule] of Object.entries(schema)) {
      const val = body[field];

      if (rule.required && (val === undefined || val === null || val === '')) {
        errors.push(`${field} est requis`); continue;
      }
      if (val === undefined || val === null) continue;

      // Type
      if (rule.type) {
        const t = Array.isArray(val) ? 'array' : typeof val;
        if (t !== rule.type) { errors.push(`${field} doit être de type ${rule.type} (reçu: ${t})`); continue; }
      }
      // minLength
      if (rule.minLength && String(val).length < rule.minLength)
        errors.push(`${field} trop court (min ${rule.minLength} chars)`);
      // min / max numérique
      if (rule.min !== undefined && Number(val) < rule.min)
        errors.push(`${field} doit être >= ${rule.min}`);
      if (rule.max !== undefined && Number(val) > rule.max)
        errors.push(`${field} doit être <= ${rule.max}`);
      // enum
      if (rule.enum && !rule.enum.includes(val))
        errors.push(`${field} doit être l'un de: ${rule.enum.join(', ')}`);
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Validation échouée', details: errors });
    }
    next();
  };
}

module.exports = { rateLimit, validate };
