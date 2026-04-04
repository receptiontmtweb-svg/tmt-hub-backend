'use strict';

const ColissimoConnector = require('./transport-colissimo');
const ChronopostConnector = require('./transport-chronopost');
const MondialRelayConnector = require('./transport-mondialrelay');
const DPDConnector = require('./transport-dpd');
const GLSConnector = require('./transport-gls');
const PacklinkConnector = require('./transport-packlink');
const Logger = require('../utils/logger');

const CONNECTORS = {
  colissimo: ColissimoConnector,
  chronopost: ChronopostConnector,
  mondialrelay: MondialRelayConnector,
  dpd: DPDConnector,
  gls: GLSConnector,
  packlink: PacklinkConnector,
};

const CARRIER_INFO = {
  colissimo: {
    name: 'Colissimo',
    company: 'La Poste',
    countries: ['FR', 'BE', 'LU', 'DE', 'ES', 'IT', 'GB', 'CH', 'NL', 'PT'],
    maxWeightKg: 30,
    features: ['domicile', 'relais', 'signature', 'assurance', 'international'],
    credentials: ['login', 'password', 'contractNumber(optionnel)'],
    docsUrl: 'https://www.colissimo.entreprise.laposte.fr/fr/api-colissimo',
  },
  chronopost: {
    name: 'Chronopost',
    company: 'Chronopost',
    countries: ['FR', 'BE', 'LU', 'DE', 'ES', 'IT', 'GB', 'CH', 'NL'],
    maxWeightKg: 30,
    features: ['express13h', 'express18h', 'samedi', 'relais', 'europe'],
    credentials: ['accountNumber', 'subAccount', 'password'],
    docsUrl: 'https://www.chronopost.fr/fr/nos-apis',
  },
  mondialrelay: {
    name: 'Mondial Relay',
    company: 'Mondial Relay',
    countries: ['FR', 'BE', 'LU', 'DE', 'ES', 'PT', 'NL'],
    maxWeightKg: 25,
    features: ['relais', 'domicile', 'europe', 'eco'],
    credentials: ['enseigne', 'privateKey', 'customerId(optionnel)'],
    docsUrl: 'https://connect.mondialrelay.com/api',
  },
  dpd: {
    name: 'DPD',
    company: 'DPD France',
    countries: ['FR', 'BE', 'LU', 'DE', 'ES', 'IT', 'GB', 'CH', 'NL', 'AT', 'PL'],
    maxWeightKg: 31.5,
    features: ['predict', 'relais', 'express', 'samedi', 'retour'],
    credentials: ['login', 'password', 'customerNumber', 'depot(optionnel)'],
    docsUrl: 'https://esolutions.dpd.com/entwickler/dpd_webservices.aspx',
  },
  gls: {
    name: 'GLS',
    company: 'GLS France',
    countries: ['FR', 'BE', 'LU', 'DE', 'ES', 'IT'],
    maxWeightKg: 30,
    features: ['domicile', 'europe'],
    credentials: ['contactId', 'login', 'password', 'environment'],
    docsUrl: 'https://api.gls-group.com',
  },
  packlink: {
    name: 'Packlink Pro',
    company: 'Packlink',
    countries: ['FR', 'EU'],
    maxWeightKg: 30,
    features: ['multi-transporteurs', 'comparateur'],
    credentials: ['apiKey'],
    docsUrl: 'https://pro.packlink.fr',
  },
};

const TransportRouter = {
  getCarriers() {
    return Object.entries(CARRIER_INFO).map(([id, info]) => ({ id, ...info }));
  },

  getConnector(carrierId) {
    const connector = CONNECTORS[carrierId];
    if (!connector) {
      throw Object.assign(
        new Error(`Transporteur inconnu: ${carrierId}. Disponibles: ${Object.keys(CONNECTORS).join(', ')}`),
        { status: 400 }
      );
    }
    return connector;
  },

  async generateLabel(carrierId, creds, shipment) {
    const connector = TransportRouter.getConnector(carrierId);
    const t0 = Date.now();

    try {
      let result;

      if (carrierId === 'colissimo') {
        const token = await connector.getToken(creds);
        result = await connector.generateLabel(token, shipment);
      } else {
        result = await connector.generateLabel(creds, shipment);
      }

      Logger.info('transport-router', 'LABEL_OK', {
        carrier: carrierId,
        tracking: result.trackingNumber,
        duration_ms: Date.now() - t0,
      });

      return result;
    } catch (e) {
      Logger.error('transport-router', 'LABEL_FAIL', {
        carrier: carrierId,
        error: e.message,
      });
      throw e;
    }
  },

  async getTracking(carrierId, trackingNumber, creds = {}) {
    const connector = TransportRouter.getConnector(carrierId);

    try {
      if (carrierId === 'colissimo') {
        return await connector.getTracking(trackingNumber, process.env.LAPOSTE_API_KEY || creds.apiKey);
      }
      if (carrierId === 'mondialrelay') {
        return await connector.getTracking(trackingNumber, creds);
      }
      return await connector.getTracking(trackingNumber, creds);
    } catch (e) {
      Logger.warn('transport-router', 'TRACKING_FAIL', {
        carrier: carrierId,
        trackingNumber,
        error: e.message,
      });
      return {
        carrier: carrierId,
        trackingNumber,
        status: 'error',
        events: [],
        error: e.message,
      };
    }
  },

  async getPickupPoints(carrierId, opts = {}) {
    const connector = TransportRouter.getConnector(carrierId);

    if (!connector.getPickupPoints) {
      return {
        carrier: carrierId,
        points: [],
        note: 'Points de retrait non supportés pour ce transporteur',
      };
    }

    try {
      let points;

      if (carrierId === 'mondialrelay') {
        points = await connector.getPickupPoints(opts);
      } else if (carrierId === 'colissimo') {
        const token = opts.token || (opts.login && await connector.getToken(opts));
        points = token ? await connector.getPickupPoints(token, opts.postalCode, opts.countryCode) : [];
      } else {
        points = await connector.getPickupPoints(opts.postalCode, opts.countryCode);
      }

      return { carrier: carrierId, count: points.length, points };
    } catch (e) {
      Logger.warn('transport-router', 'PICKUP_FAIL', {
        carrier: carrierId,
        error: e.message,
      });
      return { carrier: carrierId, points: [], error: e.message };
    }
  },

  async testConnection(carrierId, creds) {
    const connector = TransportRouter.getConnector(carrierId);
    return connector.testConnection(creds);
  },
};

module.exports = TransportRouter;