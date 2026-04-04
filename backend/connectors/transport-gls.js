'use strict';

const GLSConnector = {
  async testConnection(creds) {
    if (!creds?.login || !creds?.password) {
      return { ok: false, message: 'login et password requis' };
    }

    return {
      ok: true,
      message: 'Credentials GLS configurés (test réel lors de la première expédition)',
    };
  },

  async generateLabel() {
    throw Object.assign(new Error('GLS generateLabel à implémenter'), { status: 501 });
  },

  async getTracking() {
    throw Object.assign(new Error('GLS tracking à implémenter'), { status: 501 });
  },
};

module.exports = GLSConnector;