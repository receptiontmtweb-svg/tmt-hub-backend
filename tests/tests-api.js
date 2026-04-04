'use strict';
/**
 * tests/api.test.js — Tests routes HTTP TMT HUB v14
 * node tests/api.test.js
 */

process.env.AMZ_SANDBOX         = 'true';
process.env.OCTOPIA_SANDBOX     = 'true';
process.env.CRED_ENCRYPTION_KEY = 'test-encryption-key-min-32-chars!!';
process.env.TMT_MASTER_KEY      = 'test-master-key-minimum-32-chars!!';
process.env.NODE_ENV            = 'test';

const http = require('http');
const app  = require('../backend/server/server');

const G = { g:'\x1b[32m', r:'\x1b[31m', c:'\x1b[36m', b:'\x1b[1m', x:'\x1b[0m' };
let passed = 0, failed = 0;
let server, baseUrl;

const hdr = (t) => console.log(`\n${G.b}${G.c}▸ ${t}${G.x}`);
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

async function test(name, fn) {
  try { await fn(); console.log(`  ${G.g}✓${G.x} ${name}`); passed++; }
  catch(e) { console.log(`  ${G.r}✗${G.x} ${name}\n    → ${e.message}`); failed++; }
}

// Mini client HTTP
async function req(method, path, body, headers = {}) {
  const url  = new URL(path, baseUrl);
  const opts = {
    method:   method.toUpperCase(),
    headers:  {
      'Content-Type':  'application/json',
      'X-TMT-Key':     process.env.TMT_MASTER_KEY,
      'X-TMT-Tenant':  'test-tenant',
      ...headers,
    },
  };
  return new Promise((resolve, reject) => {
    const nodeReq = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    nodeReq.on('error', reject);
    if (body) nodeReq.write(JSON.stringify(body));
    nodeReq.end();
  });
}

async function main() {
  // Démarrer le serveur sur port libre
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`\n${G.b}Serveur de test : ${baseUrl}${G.x}`);

  // ── HEALTH ─────────────────────────────────────────────────
  hdr('GET /api/health');
  await test('Retourne 200 + version', async () => {
    const r = await req('GET', '/api/health');
    assert(r.status === 200,           `Status: ${r.status}`);
    assert(r.body.status === 'ok',     `status: ${r.body.status}`);
    assert(r.body.version === '14.0.0',`version: ${r.body.version}`);
    assert(r.body.sandbox.amazon,      'sandbox.amazon should be true');
  });
  await test('Pas d\'auth requise', async () => {
    const r = await req('GET', '/api/health', null, { 'X-TMT-Key': '' });
    assert(r.status === 200);
  });

  // ── AUTH ───────────────────────────────────────────────────
  hdr('AUTH — X-TMT-Key');
  await test('Sans clé → 401', async () => {
    const r = await req('GET', '/api/credentials', null, { 'X-TMT-Key': '' });
    assert(r.status === 401, `Attendu 401, reçu ${r.status}`);
  });
  await test('Mauvaise clé → 401', async () => {
    const r = await req('GET', '/api/credentials', null, { 'X-TMT-Key': 'wrong-key' });
    assert(r.status === 401);
  });
  await test('Bonne clé → 200', async () => {
    const r = await req('GET', '/api/credentials');
    assert(r.status === 200, `Attendu 200, reçu ${r.status}`);
  });

  // ── CREDENTIALS ────────────────────────────────────────────
  hdr('POST /api/credentials — CRUD');
  await test('Sauvegarder credentials amazon', async () => {
    const r = await req('POST', '/api/credentials', {
      marketplace: 'amazon', client_id: 'amzn1.test', client_secret: 'sec', refresh_token: 'Atzr|x',
    });
    assert(r.status === 200, `Status: ${r.status}`);
    assert(r.body.ok === true);
    assert(r.body.saved === 'amazon');
  });
  await test('Sauvegarder credentials cdiscount', async () => {
    const r = await req('POST', '/api/credentials', {
      marketplace: 'cdiscount', login: 'user@test.fr', password: 'pass123',
    });
    assert(r.status === 200 && r.body.ok);
  });
  await test('Lister les credentials configurés', async () => {
    const r = await req('GET', '/api/credentials');
    assert(r.status === 200);
    assert(Array.isArray(r.body.configured));
    assert(r.body.configured.length >= 2);
    // Vérifier que les credentials ne sont PAS exposés
    assert(!r.body.configured.some(c => c.client_secret || c.password), 'SÉCURITÉ: credentials exposés !');
  });
  await test('Vérifier statut marketplace configurée', async () => {
    const r = await req('GET', '/api/credentials/amazon/status');
    assert(r.status === 200 && r.body.configured === true);
  });
  await test('Vérifier marketplace non configurée', async () => {
    const r = await req('GET', '/api/credentials/ebay/status');
    assert(r.status === 200 && r.body.configured === false);
  });
  await test('POST sans marketplace → 400', async () => {
    const r = await req('POST', '/api/credentials', { client_id: 'test' });
    assert(r.status === 400);
  });
  await test('Supprimer credentials', async () => {
    await req('POST', '/api/credentials', { marketplace: 'to-delete', key: 'x' });
    const r = await req('DELETE', '/api/credentials/to-delete');
    assert(r.status === 200 && r.body.ok);
  });

  // ── TRANSPORT ──────────────────────────────────────────────
  hdr('GET /api/transport');
  await test('Liste transporteurs', async () => {
    const r = await req('GET', '/api/transport/carriers');
    assert(r.status === 200);
    assert(Array.isArray(r.body.carriers) && r.body.carriers.length >= 6);
  });
  await test('Estimer coût colissimo 2kg', async () => {
    const r = await req('POST', '/api/transport/estimate', { carrierId: 'colissimo', weight: 2 });
    assert(r.status === 200);
    assert(r.body.cost_ht === 7.10, `Attendu 7.10, reçu ${r.body.cost_ht}`);
  });
  await test('Comparer transporteurs', async () => {
    const r = await req('POST', '/api/transport/compare', { weight: 1.5 });
    assert(r.status === 200);
    assert(Array.isArray(r.body.comparison));
  });
  await test('Estimation sans poids → 400', async () => {
    const r = await req('POST', '/api/transport/estimate', { carrierId: 'colissimo' });
    assert(r.status === 400);
  });

  // ── PRODUCTS ───────────────────────────────────────────────
  hdr('POST /api/products — CRUD');
  await test('Créer produit', async () => {
    const r = await req('POST', '/api/products', { sku:'TEST-001', title:'Produit test', brand:'TestBrand', selling_price:29.99 });
    assert(r.status === 200 && r.body.ok);
    assert(r.body.product?.sku === 'TEST-001');
  });
  await test('Récupérer produit par SKU', async () => {
    const r = await req('GET', '/api/products/TEST-001');
    assert(r.status === 200 && r.body.product?.sku === 'TEST-001');
  });
  await test('Lister produits', async () => {
    const r = await req('GET', '/api/products');
    assert(r.status === 200 && typeof r.body.total === 'number');
  });
  await test('Stats produits', async () => {
    const r = await req('GET', '/api/products/stats');
    assert(r.status === 200 && r.body.stats?.total >= 0);
  });
  await test('Créer sans titre → 400', async () => {
    const r = await req('POST', '/api/products', { sku:'X' });
    assert(r.status === 400);
  });
  await test('404 sur SKU inexistant', async () => {
    const r = await req('GET', '/api/products/SKU-INEXISTANT-XYZ');
    assert(r.status === 404);
  });

  // ── ORDERS ─────────────────────────────────────────────────
  hdr('GET /api/orders');
  await test('Lister commandes', async () => {
    const r = await req('GET', '/api/orders');
    assert(r.status === 200 && typeof r.body.total === 'number');
  });
  await test('Stats commandes', async () => {
    const r = await req('GET', '/api/orders/stats');
    assert(r.status === 200 && r.body.stats);
  });
  await test('Sync sans marketplace → 400', async () => {
    const r = await req('POST', '/api/orders/sync', {});
    assert(r.status === 400);
  });
  await test('Sync marketplace invalide → 400', async () => {
    const r = await req('POST', '/api/orders/sync', { marketplace: 'invalid-mp' });
    assert(r.status === 400);
  });

  // ── RELAY SÉCURITÉ ─────────────────────────────────────────
  hdr('POST /api/relay — Sécurité');
  await test('Sans url → 400', async () => {
    const r = await req('POST', '/api/relay', { method: 'GET' });
    assert(r.status === 400);
  });
  await test('Domaine non autorisé → 403', async () => {
    const r = await req('POST', '/api/relay', { mp:'test', method:'GET', url:'https://evil.com/hack' });
    assert(r.status === 403, `Attendu 403, reçu ${r.status}`);
  });
  await test('Protocole http:// non autorisé → 400', async () => {
    const r = await req('POST', '/api/relay', { mp:'test', method:'GET', url:'http://sellingpartnerapi-eu.amazon.com/test' });
    assert(r.status === 400, `Attendu 400, reçu ${r.status}`);
  });
  await test('javascript: non autorisé → 400', async () => {
    const r = await req('POST', '/api/relay', { method:'GET', url:'javascript:alert(1)' });
    assert(r.status === 400);
  });

  // ── QUEUE ──────────────────────────────────────────────────
  hdr('GET /api/queue');
  await test('Stats queue', async () => {
    const r = await req('GET', '/api/queue/stats');
    assert(r.status === 200 && r.body.stats);
  });
  await test('Liste jobs', async () => {
    const r = await req('GET', '/api/queue/jobs');
    assert(r.status === 200 && Array.isArray(r.body.jobs));
  });

  // ── 404 ────────────────────────────────────────────────────
  hdr('404');
  await test('Route inconnue → 404', async () => {
    const r = await req('GET', '/api/unknown-route-xyz');
    assert(r.status === 404);
  });

  // ── FIN ────────────────────────────────────────────────────
  server.close();
  const bar = '─'.repeat(60);
  console.log(`\n${bar}`);
  console.log(`${G.b}TMT HUB v14 — Résultats tests API${G.x}`);
  console.log(`  ${G.g}✓ ${passed} tests réussis${G.x}`);
  if (failed) console.log(`  ${G.r}✗ ${failed} tests échoués${G.x}`);
  else        console.log(`  ${G.g}✓ Tous les tests passent${G.x}`);
  console.log(bar + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { server?.close(); console.error('Fatal:', e.message); process.exit(1); });
