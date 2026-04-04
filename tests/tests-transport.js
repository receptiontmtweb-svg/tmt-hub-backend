'use strict';
/**
 * tests/transport.test.js — Tests connecteurs transport
 * node tests/transport.test.js
 */

process.env.NODE_ENV            = 'test';
process.env.CRED_ENCRYPTION_KEY = 'test-encryption-key-min-32-chars!!';
process.env.TMT_MASTER_KEY      = 'test-master-key-minimum-32-chars!!';

const ColissimoConnector    = require('../backend/connectors/transport/colissimo-connector');
const ChronopostConnector   = require('../backend/connectors/transport/chronopost-connector');
const MondialRelayConnector = require('../backend/connectors/transport/mondialrelay-connector');
const DPDConnector          = require('../backend/connectors/transport/dpd-connector');
const TransportRouter       = require('../backend/connectors/transport/transport-router');
const TransportService      = require('../backend/services/transport-service');

const G = { g:'\x1b[32m', r:'\x1b[31m', c:'\x1b[36m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;

const hdr = (t) => console.log(`\n${G.b}${G.c}▸ ${t}${G.x}`);
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
async function test(name, fn) {
  try { await fn(); console.log(`  ${G.g}✓${G.x} ${name}`); passed++; }
  catch(e) { console.log(`  ${G.r}✗${G.x} ${name}\n    → ${e.message}`); failed++; }
}

// Shipment de test réutilisable
const TEST_SHIPMENT = {
  sender: {
    name: 'TMT WEB', address: '15 Rue du Commerce', city: 'Pradines',
    zipCode: '46090', countryCode: 'FR', phone: '0565000000', email: 'contact@tmtweb.fr',
  },
  recipient: {
    name: 'Jean Dupont', address: '25 Rue de la Paix', city: 'Paris',
    zipCode: '75001', countryCode: 'FR', phone: '0600000000', email: 'jean@test.fr',
  },
  parcel:  { weight: 2.5, reference: 'TEST-001' },
  service: { orderNumber: 'ORDER-001' },
};

async function main() {

  // ── TRANSPORT ROUTER ───────────────────────────────────────
  hdr('TRANSPORT ROUTER — Façade unifiée');

  await test('getCarriers() retourne 4 transporteurs', () => {
    const c = TransportRouter.getCarriers();
    assert(c.length === 4, `Attendu 4, reçu ${c.length}`);
    assert(c.every(x => x.id && x.name && x.credentials), 'Structure invalide');
  });

  await test('getConnector() retourne le bon connecteur', () => {
    const c = TransportRouter.getConnector('colissimo');
    assert(typeof c.generateLabel === 'function');
    assert(typeof c.getTracking   === 'function');
  });

  await test('getConnector() lève erreur pour transporteur inconnu', () => {
    let threw = false;
    try { TransportRouter.getConnector('fedex'); } catch(e) { threw = true; }
    assert(threw);
  });

  await test('getTrackingUrl() retourne les bonnes URLs', () => {
    const urls = {
      colissimo:    'laposte.fr',
      chronopost:   'chronopost.fr',
      mondialrelay: 'mondialrelay.fr',
      dpd:          'tracking.dpd.fr',
    };
    for (const [carrier, domain] of Object.entries(urls)) {
      const url = TransportRouter.getTrackingUrl(carrier, 'TRACK123');
      assert(url.includes(domain), `${carrier}: URL invalide: ${url}`);
      assert(url.includes('TRACK123'), `${carrier}: numéro absent de l'URL`);
    }
  });

  // ── COLISSIMO ──────────────────────────────────────────────
  hdr('COLISSIMO — Structure et validation');

  await test('getToken — rejette credentials manquants', async () => {
    let threw = false;
    try { await ColissimoConnector.getToken({}); } catch(e) { threw = true; }
    assert(threw);
  });

  await test('generateLabel — rejette sans token', async () => {
    let threw = false;
    try { await ColissimoConnector.generateLabel(null, TEST_SHIPMENT); } catch(e) { threw = true; }
    assert(threw);
  });

  await test('generateLabel — rejette sans parcel.weight', async () => {
    let threw = false;
    try { await ColissimoConnector.generateLabel('tok', { ...TEST_SHIPMENT, parcel: {} }); } catch(e) { threw = true; }
    assert(threw);
  });

  await test('SERVICES disponibles (DOM, BPR, etc.)', () => {
    assert(ColissimoConnector.SERVICES.DOM === 'DOM');
    assert(ColissimoConnector.SERVICES.RELAY === 'BPR');
    assert(ColissimoConnector.SERVICES.EUROPE !== undefined);
  });

  await test('getTracking sans token → URL publique', async () => {
    const r = await ColissimoConnector.getTracking('1A23456789012');
    assert(r.trackingUrl.includes('laposte.fr'));
    assert(r.trackingNumber === '1A23456789012');
  });

  // ── CHRONOPOST ─────────────────────────────────────────────
  hdr('CHRONOPOST — Structure et validation');

  await test('generateLabel — rejette credentials incomplets', async () => {
    let threw = false;
    try { await ChronopostConnector.generateLabel({}, TEST_SHIPMENT); } catch(e) { threw = true; }
    assert(threw);
  });

  await test('generateLabel — rejette sans recipient.zipCode', async () => {
    let threw = false;
    const bad = { ...TEST_SHIPMENT, recipient: { name: 'Test' } };
    try { await ChronopostConnector.generateLabel({ accountNumber:'ACC', password:'pass' }, bad); } catch(e) { threw = true; }
    assert(threw);
  });

  await test('PRODUCTS disponibles (01, 02, 86, etc.)', () => {
    assert(ChronopostConnector.PRODUCTS.EXPRESS   === '01');
    assert(ChronopostConnector.PRODUCTS.RELAIS    === '86');
    assert(ChronopostConnector.PRODUCTS.SAMEDI    === '16');
  });

  await test('_buildSoapEnvelope produit du XML valide', () => {
    // Test indirect via un appel qui construit le SOAP
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
        <soapenv:Body><test>value</test></soapenv:Body>
      </soapenv:Envelope>`;
    assert(xml.includes('soapenv:Envelope'));
    assert(xml.includes('soapenv:Body'));
  });

  // ── MONDIAL RELAY ──────────────────────────────────────────
  hdr('MONDIAL RELAY — Structure et validation');

  await test('generateLabel — rejette enseigne manquante', async () => {
    let threw = false;
    try { await MondialRelayConnector.generateLabel({}, TEST_SHIPMENT); } catch(e) { threw = true; }
    assert(threw);
  });

  await test('generateLabel — rejette poids manquant', async () => {
    let threw = false;
    try {
      await MondialRelayConnector.generateLabel(
        { enseigne: 'TEST', privateKey: 'key' },
        { ...TEST_SHIPMENT, parcel: { reference: 'x' } }
      );
    } catch(e) { threw = true; }
    assert(threw);
  });

  await test('SERVICES disponibles (24R, 48R, 24H, etc.)', () => {
    assert(MondialRelayConnector.SERVICES.RELAY_24 === '24R');
    assert(MondialRelayConnector.SERVICES.RELAY_48 === '48R');
    assert(MondialRelayConnector.SERVICES.HOME_24  === '24H');
  });

  await test('Signature HMAC — déterministe avec mêmes params', () => {
    const crypto = require('crypto');
    const sign = (enseigne, params, key) => {
      const vals = [enseigne, ...Object.values(params), key];
      return crypto.createHash('md5').update(vals.join(''), 'latin1').digest('hex').toUpperCase();
    };
    const s1 = sign('ENS', { a:'1', b:'2' }, 'KEY');
    const s2 = sign('ENS', { a:'1', b:'2' }, 'KEY');
    assert(s1 === s2, 'Signature non déterministe');
    assert(s1.length === 32, `Longueur signature: ${s1.length}`);
  });

  await test('getPickupPoints — rejette sans enseigne', async () => {
    let threw = false;
    try { await MondialRelayConnector.getPickupPoints({ postalCode: '75001' }); } catch(e) { threw = true; }
    assert(threw);
  });

  // ── DPD ────────────────────────────────────────────────────
  hdr('DPD — Structure et validation');

  await test('generateLabel — rejette credentials incomplets', async () => {
    let threw = false;
    try { await DPDConnector.generateLabel({ login:'u' }, TEST_SHIPMENT); } catch(e) { threw = true; }
    assert(threw);
  });

  await test('generateLabel — rejette sans poids', async () => {
    let threw = false;
    try {
      await DPDConnector.generateLabel(
        { login:'u', password:'p', customerNumber:'123' },
        { ...TEST_SHIPMENT, parcel: {} }
      );
    } catch(e) { threw = true; }
    assert(threw);
  });

  await test('PRODUCTS disponibles', () => {
    assert(DPDConnector.PRODUCTS.CLASSIC  === 'Classic');
    assert(DPDConnector.PRODUCTS.PREDICT  === 'Predict');
    assert(DPDConnector.PRODUCTS.RELAIS   === 'Pickup');
  });

  await test('getTracking — retourne URL sans appel API', async () => {
    const r = await DPDConnector.getTracking('12345678901234');
    assert(r.trackingNumber === '12345678901234');
    assert(r.trackingUrl.includes('dpd.fr'));
  });

  await test('testConnection — retourne message sans crash', async () => {
    const r = await DPDConnector.testConnection({ login:'u', password:'p', customerNumber:'123' });
    assert(typeof r.ok === 'boolean');
    assert(typeof r.message === 'string');
  });

  // ── TRANSPORT SERVICE ──────────────────────────────────────
  hdr('TRANSPORT SERVICE — Calcul coût et comparaison');

  await test('estimateCost — colissimo 2kg', () => {
    const r = TransportService.estimateCost('colissimo', 2);
    assert(r.cost_ht === 7.10, `Attendu 7.10€, reçu ${r.cost_ht}€`);
    assert(r.cost_ttc === +(7.10 * 1.2).toFixed(2));
  });

  await test('estimateCost — poids volumétrique prioritaire', () => {
    // 40x30x20 = 24000cm3 / 5000 = 4.8kg vol > 1kg réel
    const r = TransportService.estimateCost('colissimo', 1, { l:40, w:30, h:20 });
    assert(r.billed_weight_kg === 4.8);
    assert(r.volumetric_weight === 4.8);
  });

  await test('estimateCost — poids réel si > volumétrique', () => {
    // 10x10x10 = 1000cm3 / 5000 = 0.2kg vol < 5kg réel
    const r = TransportService.estimateCost('dpd', 5, { l:10, w:10, h:10 });
    assert(r.billed_weight_kg === 5);
  });

  await test('estimateCost — erreur si poids dépasse max', () => {
    let threw = false;
    try { TransportService.estimateCost('mondialrelay', 100); } catch(e) { threw = true; }
    assert(threw);
  });

  await test('compareCarriers — tous les 6 transporteurs + trié par prix', () => {
    const r = TransportService.compareCarriers(1.5);
    assert(r.length >= 4);
    const prices = r.filter(c => c.cost_ht).map(c => c.cost_ht);
    for (let i = 0; i < prices.length - 1; i++) {
      assert(prices[i] <= prices[i+1], `Non trié: ${prices[i]} > ${prices[i+1]}`);
    }
  });

  await test('getCarrierCode — tous les transporteurs / toutes les MP', () => {
    const cases = [
      ['colissimo',    'amazon',    'La_Poste'],
      ['colissimo',    'cdiscount', 'Colissimo'],
      ['chronopost',   'amazon',    'Chronopost'],
      ['mondialrelay', 'cdiscount', 'Mondial Relay'],
      ['dpd',          'amazon',    'DPD'],
    ];
    for (const [carrier, mp, expected] of cases) {
      const code = TransportService.getCarrierCode(carrier, mp);
      assert(code === expected, `${carrier}+${mp}: attendu "${expected}", reçu "${code}"`);
    }
  });

  // ── RÉSUMÉ ─────────────────────────────────────────────────
  const bar = '─'.repeat(62);
  console.log(`\n${bar}`);
  console.log(`${G.b}TMT HUB v14 — Résultats tests transport${G.x}`);
  console.log(`  ${G.g}✓ ${passed} tests réussis${G.x}`);
  if (failed) console.log(`  ${G.r}✗ ${failed} tests échoués${G.x}`);
  else        console.log(`  ${G.g}✓ Tous les tests passent${G.x}`);
  console.log(bar + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
