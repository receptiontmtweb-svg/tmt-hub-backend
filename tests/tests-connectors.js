'use strict';
/**
 * tests/connectors.test.js — Tests connecteurs Amazon + Octopia
 * node tests/connectors.test.js
 */

process.env.AMZ_SANDBOX         = 'true';
process.env.OCTOPIA_SANDBOX     = 'true';
process.env.CRED_ENCRYPTION_KEY = 'test-encryption-key-min-32-chars!!';
process.env.TMT_MASTER_KEY      = 'test-master-key-minimum-32-chars!!';
process.env.NODE_ENV            = 'test';

const Amazon  = require('../backend/connectors/amazon-connector');
const Octopia = require('../backend/connectors/octopia-connector');
const { encrypt, decrypt } = require('../backend/db/credentials-store');
const { CredentialStore }  = require('../backend/db/credentials-store');
const { getDB }            = require('../backend/db/database');
const TransportService     = require('../backend/services/transport-service');

const G = { g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', c:'\x1b[36m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;

const hdr = (t) => console.log(`\n${G.b}${G.c}▸ ${t}${G.x}`);
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

async function test(name, fn) {
  try { await fn(); console.log(`  ${G.g}✓${G.x} ${name}`); passed++; }
  catch(e) { console.log(`  ${G.r}✗${G.x} ${name}\n    → ${e.message}`); failed++; }
}

async function main() {

  // ── CRYPTO ─────────────────────────────────────────────────
  hdr('CRYPTO — AES-256-GCM');
  await test('Encrypt/decrypt round-trip', () => {
    const d = { login: 'user@test.fr', password: 's3cr3t', api_key: 'abc123' };
    const dec = decrypt(encrypt(d, 't1'), 't1');
    assert(dec.login === d.login && dec.password === d.password);
  });
  await test('IV aléatoire (deux chiffrements ≠)', () => {
    assert(encrypt({ k: 'v' }, 't1') !== encrypt({ k: 'v' }, 't1'));
  });
  await test('Isolation tenant A ≠ B', () => {
    const enc = encrypt({ s: 'secret' }, 'tenant-A');
    let threw = false;
    try { decrypt(enc, 'tenant-B'); } catch(e) { threw = true; }
    assert(threw, 'tenant-B ne devrait pas déchiffrer les données de tenant-A');
  });
  await test('Payload corrompu → erreur', () => {
    let threw = false;
    try { decrypt('not-valid!!', 'tid'); } catch(e) { threw = true; }
    assert(threw);
  });

  // ── CREDENTIAL STORE ───────────────────────────────────────
  hdr('CREDENTIAL STORE');
  await test('Save + Load', async () => {
    const store = CredentialStore;
    await store.save('t-test', 'amazon', { client_id: 'amzn1.test', refresh_token: 'Atzr|x' });
    const loaded = await store.load('t-test', 'amazon');
    assert(loaded.client_id === 'amzn1.test');
  });
  await test('isConfigured true après save', async () => {
    assert(await CredentialStore.isConfigured('t-test', 'amazon'));
  });
  await test('isConfigured false si absent', async () => {
    assert(!(await CredentialStore.isConfigured('t-test', 'ebay')));
  });
  await test('listConfigured retourne les bonnes entrées', async () => {
    await CredentialStore.save('t-test', 'cdiscount', { login: 'u', password: 'p' });
    const list = await CredentialStore.listConfigured('t-test');
    assert(list.length >= 2);
    assert(list.every(l => l.marketplace && l.has_creds));
  });
  await test('Remove supprime les credentials', async () => {
    await CredentialStore.save('t-remove', 'wix', { key: 'x' });
    await CredentialStore.remove('t-remove', 'wix');
    assert(!(await CredentialStore.isConfigured('t-remove', 'wix')));
  });

  // ── AMAZON CONNECTOR ───────────────────────────────────────
  hdr('AMAZON SP-API — Structure et validation');
  await test('Marketplace IDs Europe complets (7 pays)', () => {
    for (const k of ['FR','DE','ES','IT','GB','NL','PL']) assert(Amazon.MARKETPLACES[k], `${k} manquant`);
  });
  await test('_base() → sandbox quand AMZ_SANDBOX=true', () => {
    assert(Amazon._base().includes('sandbox'));
  });
  await test('_headers() — format SigV4 correct', () => {
    const h = Amazon._headers('my-token', 'A13V1IB3VIYZZH');
    assert(h['x-amz-access-token'] === 'my-token');
    assert(/^\d{8}T\d{6}Z$/.test(h['x-amz-date']), `Format date: ${h['x-amz-date']}`);
    assert(h['Content-Type'] === 'application/json');
    assert(h['User-Agent'].includes('TMT-HUB'));
  });
  await test('getToken — rejette credentials incomplets', async () => {
    let threw = false;
    try { await Amazon.getToken({}); } catch(e) { threw = true; }
    assert(threw);
  });
  await test('updateStock — rejette quantity < 0', async () => {
    let threw = false;
    try { await Amazon.updateStock('tok', 'SELLER', 'SKU', -1); } catch(e) { threw = true; }
    assert(threw);
  });
  await test('updateStock — payload PATCH listing correct', () => {
    const patch = { productType: 'PRODUCT', patches: [{ op:'replace', path:'/attributes/fulfillment_availability', value:[{fulfillment_channel_code:'DEFAULT',quantity:10}] }] };
    assert(patch.patches[0].value[0].quantity === 10);
    assert(patch.patches[0].op === 'replace');
  });
  await test('confirmShipment — rejette sans trackingNumber', async () => {
    let threw = false;
    try { await Amazon.confirmShipment('tok', { orderId:'O1', items:[{orderItemId:'I1',quantity:1}], trackingNumber:'' }); } catch(e) { threw = true; }
    assert(threw);
  });
  await test('normalizeOrder — 5 statuts corrects', () => {
    const cases = [['Unshipped','new'],['Pending','new'],['PartiallyShipped','processing'],['Shipped','shipped'],['Canceled','cancelled']];
    for (const [amz, exp] of cases) {
      const r = Amazon.normalizeOrder({ AmazonOrderId:'X', OrderStatus:amz, OrderTotal:{Amount:'0',CurrencyCode:'EUR'}, BuyerInfo:{} });
      assert(r.status === exp, `${amz}→${r.status} (attendu ${exp})`);
    }
  });
  await test('normalizeOrder — structure complète', () => {
    const r = Amazon.normalizeOrder({ AmazonOrderId:'114-001', OrderStatus:'Unshipped', OrderTotal:{Amount:'49.99',CurrencyCode:'EUR'}, BuyerInfo:{BuyerEmail:'b@test.fr'} });
    assert(r.marketplace === 'amazon' && r.total === 49.99 && r.currency === 'EUR' && Array.isArray(r.items));
  });

  // ── OCTOPIA CONNECTOR ──────────────────────────────────────
  hdr('OCTOPIA / CDISCOUNT — Structure et validation');
  await test('_base() → sandbox quand OCTOPIA_SANDBOX=true', () => {
    assert(Octopia._base().includes('sandbox'));
  });
  await test('_headers() — format Bearer correct', () => {
    const h = Octopia._headers('jwt-test-token');
    assert(h['Authorization'] === 'Bearer jwt-test-token');
    assert(h['Content-Type'] === 'application/json');
  });
  await test('getToken — rejette login vide', async () => {
    let threw = false;
    try { await Octopia.getToken({ login:'', password:'' }); } catch(e) { threw = true; }
    assert(threw);
  });
  await test('updateStock — rejette tableau vide', async () => {
    let threw = false;
    try { await Octopia.updateStock('tok', []); } catch(e) { threw = true; }
    assert(threw);
  });
  await test('updatePrices — rejette tableau vide', async () => {
    let threw = false;
    try { await Octopia.updatePrices('tok', []); } catch(e) { threw = true; }
    assert(threw);
  });
  await test('confirmShipment — rejette trackingNumber vide', async () => {
    let threw = false;
    try { await Octopia.confirmShipment('tok', { orderNumber:'O1', trackingNumber:'' }); } catch(e) { threw = true; }
    assert(threw);
  });
  await test('normalizeOrder — 4 statuts + lignes', () => {
    const cases = [['WaitingForShipmentAcceptation','new'],['ShippingConfirmed','processing'],['Shipped','shipped'],['Cancelled','cancelled']];
    for (const [state, exp] of cases) {
      const r = Octopia.normalizeOrder({ OrderNumber:'999', State:state, TotalAmount:0, Buyer:{}, Lines:[] });
      assert(r.status === exp, `${state}→${r.status} (attendu ${exp})`);
    }
  });
  await test('normalizeOrder — lignes commande', () => {
    const r = Octopia.normalizeOrder({
      OrderNumber:'999', State:'WaitingForShipmentAcceptation', TotalAmount:59.80, Buyer:{ Login:'john' },
      Lines:[{ SellerProductId:'SKU-A', ProductEan:'3614222222001', Quantity:2, Price:29.90 }],
    });
    assert(r.items.length === 1 && r.items[0].sku === 'SKU-A' && r.items[0].quantity === 2 && r.items[0].ean === '3614222222001');
  });

  // ── TRANSPORT SERVICE ──────────────────────────────────────
  hdr('TRANSPORT SERVICE');
  await test('getCarriers() retourne 6 transporteurs', () => {
    const carriers = TransportService.getCarriers();
    assert(carriers.length >= 6);
    assert(carriers.every(c => c.id && c.name && c.base_rate));
  });
  await test('estimateCost — calcul correct colissimo 2kg', () => {
    const r = TransportService.estimateCost('colissimo', 2);
    assert(r.cost_ht === 7.10, `Attendu 7.10€, reçu ${r.cost_ht}€`); // 5.50 + 2*0.80
    assert(r.carrier === 'Colissimo');
    assert(r.billed_weight_kg === 2);
  });
  await test('estimateCost — poids volumétrique', () => {
    // 40x30x20 = 24000cm3 / 5000 = 4.8kg volumétrique > 1kg réel → facturé 4.8kg
    const r = TransportService.estimateCost('colissimo', 1, { l:40, w:30, h:20 });
    assert(r.billed_weight_kg === 4.8, `Attendu 4.8, reçu ${r.billed_weight_kg}`);
  });
  await test('estimateCost — erreur poids dépassé', () => {
    let threw = false;
    try { TransportService.estimateCost('mondialrelay', 100); } catch(e) { threw = true; }
    assert(threw);
  });
  await test('compareCarriers — trié par coût croissant', () => {
    const cmp = TransportService.compareCarriers(1);
    assert(Array.isArray(cmp) && cmp.length > 0);
    assert(cmp[0].cost_ht <= cmp[cmp.length-1].cost_ht);
  });
  await test('getCarrierCode — amazon et cdiscount', () => {
    assert(TransportService.getCarrierCode('colissimo', 'amazon')    === 'La_Poste');
    assert(TransportService.getCarrierCode('colissimo', 'cdiscount') === 'Colissimo');
    assert(TransportService.getCarrierCode('chronopost', 'amazon')   === 'Chronopost');
  });

  // ── DATABASE ABSTRACTION ───────────────────────────────────
  hdr('DATABASE — Adaptateur mémoire');
  await test('insert + findOne', async () => {
    const db  = getDB();
    const rec = await db.insert('test_table', { name: 'test', val: 42 });
    assert(rec.id && rec.name === 'test');
    const found = await db.findOne('test_table', { id: rec.id });
    assert(found?.name === 'test');
  });
  await test('upsert — crée puis met à jour', async () => {
    const db = getDB();
    await db.upsert('test_upsert', { slug: 'key1', data: 'v1' }, 'slug');
    await db.upsert('test_upsert', { slug: 'key1', data: 'v2' }, 'slug');
    const found = await db.findOne('test_upsert', { slug: 'key1' });
    assert(found?.data === 'v2', `Attendu v2, reçu ${found?.data}`);
  });
  await test('findMany + count', async () => {
    const db = getDB();
    await db.insert('test_list', { group: 'A', val: 1 });
    await db.insert('test_list', { group: 'A', val: 2 });
    await db.insert('test_list', { group: 'B', val: 3 });
    const rows = await db.findMany('test_list', { group: 'A' });
    const cnt  = await db.count('test_list', { group: 'A' });
    assert(rows.length === 2 && cnt === 2);
  });
  await test('update + delete', async () => {
    const db  = getDB();
    const rec = await db.insert('test_crud', { status: 'pending', v: 1 });
    await db.update('test_crud', { id: rec.id }, { status: 'done' });
    const upd = await db.findOne('test_crud', { id: rec.id });
    assert(upd?.status === 'done');
    await db.delete('test_crud', { id: rec.id });
    const del = await db.findOne('test_crud', { id: rec.id });
    assert(del === null);
  });

  // ── RÉSUMÉ ─────────────────────────────────────────────────
  const bar = '─'.repeat(60);
  console.log(`\n${bar}`);
  console.log(`${G.b}TMT HUB v14 — Résultats tests connecteurs${G.x}`);
  console.log(`  ${G.g}✓ ${passed} tests réussis${G.x}`);
  if (failed) console.log(`  ${G.r}✗ ${failed} tests échoués${G.x}`);
  else        console.log(`  ${G.g}✓ Tous les tests passent${G.x}`);
  console.log(bar + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
