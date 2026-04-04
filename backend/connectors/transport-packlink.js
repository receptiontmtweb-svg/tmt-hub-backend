'use strict';

const Logger = require('../utils/logger');

const ENDPOINT = 'https://api.packlink.com';

const PacklinkConnector = {
  async testConnection(creds) {
    if (!creds?.apiKey) {
      return { ok: false, message: 'apiKey requis' };
    }

    try {
      const res = await fetch(`${ENDPOINT}/v1/shipments`, {
        method: 'GET',
        headers: {
          Authorization: creds.apiKey,
          Accept: 'application/json',
          'User-Agent': 'TMT-HUB/14.0',
        },
      });

      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: 'API key Packlink invalide ou refusée' };
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return {
          ok: false,
          message: `Packlink HTTP ${res.status}${txt ? ' - ' + txt.slice(0, 150) : ''}`,
        };
      }

      return { ok: true, message: 'Connexion Packlink OK' };
    } catch (e) {
      Logger.error('packlink', 'TEST_FAIL', { error: e.message });
      return { ok: false, message: e.message };
    }
  },

  async generateLabel() {
    throw Object.assign(new Error('Packlink generateLabel à implémenter'), { status: 501 });
  },

  async getTracking() {
    throw Object.assign(new Error('Packlink tracking à implémenter'), { status: 501 });
  },
};

module.exports = PacklinkConnector;