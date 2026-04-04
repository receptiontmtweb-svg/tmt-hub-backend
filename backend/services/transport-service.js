'use strict';
/**
 * services/transport-service.js — Module transport
 *
 * Transporteurs supportés : Colissimo, Chronopost, Mondial Relay, DPD, GLS, UPS
 * Fonctions : configuration, calcul coût, création expéditions, suivi
 */

const { getDB } = require('../db/database');
const Logger    = require('../utils/logger');

// ── Grilles tarifaires indicatives ───────────────────────────
const CARRIER_RATES = {
  colissimo:   { base: 5.50,  perKg: 0.80,  maxKg: 30, name: 'Colissimo' },
  chronopost:  { base: 9.80,  perKg: 1.20,  maxKg: 30, name: 'Chronopost' },
  mondialrelay:{ base: 3.50,  perKg: 0.50,  maxKg: 25, name: 'Mondial Relay' },
  dpd:         { base: 5.20,  perKg: 0.75,  maxKg: 31.5, name: 'DPD' },
  gls:         { base: 5.00,  perKg: 0.70,  maxKg: 40, name: 'GLS' },
  ups:         { base: 12.00, perKg: 1.80,  maxKg: 70, name: 'UPS' },
};

// Codes transporteurs acceptés par les marketplaces
const CARRIER_CODES = {
  colissimo:    { amazon: 'La_Poste',     cdiscount: 'Colissimo' },
  chronopost:   { amazon: 'Chronopost',   cdiscount: 'Chronopost' },
  mondialrelay: { amazon: 'Mondial_Relay',cdiscount: 'Mondial Relay' },
  dpd:          { amazon: 'DPD',          cdiscount: 'DPD' },
  gls:          { amazon: 'GLS',          cdiscount: 'GLS' },
  ups:          { amazon: 'UPS',          cdiscount: 'UPS' },
  other:        { amazon: 'Other',        cdiscount: 'Autre' },
};

const TransportService = {

  /** Liste des transporteurs disponibles */
  getCarriers() {
    return Object.entries(CARRIER_RATES).map(([id, r]) => ({
      id,
      name:      r.name,
      max_kg:    r.maxKg,
      base_rate: r.base,
    }));
  },

  /**
   * Calculer le coût d'expédition estimé
   * @param {string} carrierId
   * @param {number} weightKg
   * @param {object} dims — { l, w, h } en cm (pour poids volumétrique)
   * @returns { carrier, cost_ht, cost_ttc, volumetric_weight, billed_weight }
   */
  estimateCost(carrierId, weightKg, dims = {}) {
    const carrier = CARRIER_RATES[carrierId];
    if (!carrier) throw new Error(`Transporteur inconnu: ${carrierId}`);

    // Poids volumétrique (diviseur 5000 standard)
    const volWeight = dims.l && dims.w && dims.h
      ? (dims.l * dims.w * dims.h) / 5000
      : 0;
    const billedWeight = Math.max(weightKg, volWeight);

    if (billedWeight > carrier.maxKg)
      throw new Error(`Poids ${billedWeight}kg dépasse le max ${carrier.maxKg}kg pour ${carrier.name}`);

    const costHT  = carrier.base + (billedWeight * carrier.perKg);
    const costTTC = +(costHT * 1.2).toFixed(2);

    return {
      carrier:           carrier.name,
      carrier_id:        carrierId,
      billed_weight_kg:  +billedWeight.toFixed(3),
      volumetric_weight: +volWeight.toFixed(3),
      cost_ht:           +costHT.toFixed(2),
      cost_ttc:          costTTC,
    };
  },

  /** Comparer tous les transporteurs pour un colis */
  compareCarriers(weightKg, dims = {}) {
    return Object.keys(CARRIER_RATES).map(id => {
      try { return TransportService.estimateCost(id, weightKg, dims); }
      catch(e) { return { carrier_id: id, error: e.message }; }
    }).sort((a, b) => (a.cost_ht || 999) - (b.cost_ht || 999));
  },

  /** Créer une expédition en DB */
  async createShipment(tenantId, { orderId, marketplace, carrierId, trackingNumber, labelUrl, weight, dims }) {
    const db = getDB();
    const cost = TransportService.estimateCost(carrierId, weight || 1, dims || {});

    const shipment = await db.insert('shipments', {
      company_id:      tenantId,
      order_id:        orderId,
      marketplace,
      carrier:         carrierId,
      carrier_name:    CARRIER_RATES[carrierId]?.name || carrierId,
      tracking_number: trackingNumber,
      label_url:       labelUrl   || null,
      status:          'created',
      weight_kg:       weight     || null,
      cost_ht:         cost.cost_ht,
      cost_ttc:        cost.cost_ttc,
    });

    Logger.audit('SHIPMENT_CREATED', tenantId, { orderId, carrierId, trackingNumber });
    return shipment;
  },

  /** Récupérer les expéditions */
  async getShipments(tenantId, filters = {}) {
    const db = getDB();
    const dbFilters = { company_id: tenantId };
    if (filters.status)    dbFilters.status    = filters.status;
    if (filters.carrier)   dbFilters.carrier   = filters.carrier;
    if (filters.marketplace) dbFilters.marketplace = filters.marketplace;
    return db.findMany('shipments', dbFilters, { order: 'created_at', asc: false });
  },

  /** Mettre à jour le statut d'un suivi */
  async updateTracking(tenantId, trackingNumber, status) {
    const db = getDB();
    await db.update('shipments', { company_id: tenantId, tracking_number: trackingNumber }, { status, updated_at: new Date().toISOString() });
    Logger.info('transport-service', 'TRACKING_UPDATED', { trackingNumber, status });
  },

  /** Code carrier pour une marketplace */
  getCarrierCode(carrierId, marketplace) {
    return CARRIER_CODES[carrierId]?.[marketplace] || CARRIER_CODES.other[marketplace] || carrierId;
  },

  /** Stats transport */
  async getStats(tenantId) {
    const db        = getDB();
    const shipments = await db.findMany('shipments', { company_id: tenantId });
    const byCarrier = {};
    for (const s of shipments) {
      byCarrier[s.carrier] = (byCarrier[s.carrier] || 0) + 1;
    }
    return {
      total:      shipments.length,
      by_status:  shipments.reduce((acc, s) => { acc[s.status] = (acc[s.status]||0)+1; return acc; }, {}),
      by_carrier: byCarrier,
      avg_cost:   shipments.length ? +(shipments.reduce((s,sh) => s + (sh.cost_ht||0), 0) / shipments.length).toFixed(2) : 0,
    };
  },
};

module.exports = TransportService;
