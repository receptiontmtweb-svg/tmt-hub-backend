'use strict';
/**
 * utils/logger.js — Logger structuré JSON + Audit trail
 * Compatible Vercel, Datadog, CloudWatch, stdout
 */

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, AUDIT: 50 };
const COLORS = {
  DEBUG: '\x1b[36m', INFO: '\x1b[32m', WARN: '\x1b[33m',
  ERROR: '\x1b[31m', AUDIT: '\x1b[35m', RESET: '\x1b[0m',
};

const isProd = process.env.NODE_ENV === 'production';
const minLevel = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] || LEVELS.INFO;

function write(level, category, message, meta = {}) {
  if (LEVELS[level] < minLevel) return;

  const entry = {
    ts:       new Date().toISOString(),
    level,
    category: category || 'system',
    message:  String(message).slice(0, 1000),
    ...sanitizeMeta(meta),
  };

  if (isProd) {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const color = COLORS[level] || COLORS.RESET;
    const meta_str = Object.keys(meta).length
      ? ' ' + Object.entries(sanitizeMeta(meta)).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(' ')
      : '';
    console.log(`${color}[${level}]${COLORS.RESET} [${category}] ${message}${meta_str}`);
  }
}

// Ne jamais logger des champs sensibles
const SENSITIVE = new Set(['password','secret','token','refresh_token','client_secret','api_key','encryption_key']);
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  return Object.fromEntries(
    Object.entries(meta).map(([k, v]) => [
      k,
      SENSITIVE.has(k.toLowerCase()) ? '[REDACTED]' : (typeof v === 'object' ? JSON.stringify(v).slice(0,200) : String(v).slice(0,200))
    ])
  );
}

const Logger = {
  debug  (cat, msg, meta) { write('DEBUG', cat, msg, meta); },
  info   (cat, msg, meta) { write('INFO',  cat, msg, meta); },
  warn   (cat, msg, meta) { write('WARN',  cat, msg, meta); },
  error  (cat, msg, meta) { write('ERROR', cat, msg, meta); },

  /**
   * Audit trail — actions sensibles (credentials, sync, modifications)
   * Toujours loggé quel que soit LOG_LEVEL
   */
  audit(action, tenantId, details = {}) {
    const entry = {
      ts:        new Date().toISOString(),
      level:     'AUDIT',
      action,
      tenant_id: tenantId || 'unknown',
      ...sanitizeMeta(details),
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
  },

  /** Logguer une requête HTTP entrante */
  request(req, res, duration) {
    write('INFO', 'http', `${req.method} ${req.path}`, {
      status:      res.statusCode,
      duration_ms: duration,
      ip:          (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      tenant:      req.tenantId || '-',
    });
  },
};

module.exports = Logger;
