'use strict';
/**
 * middleware/auth.js
 */

const Logger = require('../utils/logger');

function requireAuth(req, res, next) {
  req.tenantId = req.headers['x-tmt-tenant'] || 'default';

  const providedKey = req.headers['x-tmt-key'] || '';
  const expectedKey = process.env.TMT_MASTER_KEY || '';

  if (!expectedKey) {
    Logger.error('auth', 'MISSING_MASTER_KEY', { path: req.path });
    return res.status(500).json({ error: 'Configuration serveur invalide' });
  }

  if (!providedKey || providedKey !== expectedKey) {
    Logger.warn('auth', 'UNAUTHORIZED', {
      path: req.path,
      ip: req.ip,
      tenantId: req.tenantId,
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

function optionalAuth(req, res, next) {
  req.tenantId = req.headers['x-tmt-tenant'] || 'default';
  return next();
}

module.exports = { requireAuth, optionalAuth };