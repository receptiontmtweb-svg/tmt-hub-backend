'use strict';
/**
 * connectors/transport/colissimo-connector.js
 * La Poste — Colissimo API v2
 *
 * Documentation : https://www.colissimo.entreprise.laposte.fr/fr/api-colissimo
 *
 * Méthodes :
 *   getToken(creds)                    → session token
 *   generateLabel(token, shipment)     → { labelUrl, trackingNumber, base64Pdf }
 *   getTracking(trackingNumber)        → { status, events[] }
 *   checkAddress(address)              → { valid, normalized }
 *   getPickupPoints(postalCode)        → Point[] (points de retrait)
 *   estimatePrice(parcel)              → { price }
 *
 * Credentials requis :
 *   login    : identifiant Colissimo Pro
 *   password : mot de passe API
 *   contractNumber : numéro de contrat (optionnel)
 */

const Logger = require('\.\./utils/logger');

const ENDPOINTS = {
  PROD:     'https://ws.colissimo.fr',
  SANDBOX:  'https://ws.colissimo.fr', // Colissimo n'a pas de sandbox distincte
  TRACKING: 'https://www.laposte.fr/outils/suivre-vos-envois',
  TRACKING_API: 'https://api.laposte.fr/suivi/v2/idships',
};

// Codes services Colissimo
const SERVICES = {
  DOM:        'DOM',   // Domicile France
  RELAY:      'BPR',   // Bureau de Poste / Relais
  A2P:        'A2P',   // Consigne Pickup Station
  COLIRECTO:  'CDS',   // Colissimo Direct Signature
  EXPERT:     'DOS',   // Expert France
  OUTREMER:   'COM',   // Outre-mer
  EUROPE:     'COLI',  // Europe
  INTERNATIONAL: 'INTS', // International
};

function _base() {
  return process.env.COLISSIMO_SANDBOX === 'true' ? ENDPOINTS.SANDBOX : ENDPOINTS.PROD;
}

function _parseErr(d) {
  return d?.messages?.[0]?.messageContent
    || d?.errorMessage
    || d?.message
    || 'Colissimo error';
}

async function _fetch(url, opts, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 && i < retries) {
        await new Promise(r => setTimeout(r, (i + 1) * 2000)); continue;
      }
      return res;
    } catch(e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, (i + 1) * 1500));
    }
  }
  throw lastErr || new Error('Colissimo: fetch failed');
}

const ColissimoConnector = {
  SERVICES,

  /**
   * Authentification — obtenir un token de session
   * @param {object} creds - { login, password }
   * @returns {string} token (valide plusieurs heures)
   */
  async getToken({ login, password }) {
    if (!login || !password)
      throw Object.assign(new Error('Colissimo: login et password requis'), { status: 400 });

    const res = await _fetch(`${_base()}/sls-ws/SlsServiceWSRest/2.0/getToken`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ login, password }),
    });

    const d = await res.json();
    if (!res.ok || d.token === null)
      throw new Error(_parseErr(d));

    Logger.info('colissimo', 'TOKEN_OK', { login });
    return d.token;
  },

  /**
   * Générer une étiquette d'expédition
   *
   * @param {string} token
   * @param {object} shipment
   *   sender:   { companyName, address, city, zipCode, countryCode, phone, email }
   *   recipient:{ lastName, firstName, companyName?, address, city, zipCode, countryCode, phone, email }
   *   parcel:   { weight, width?, height?, length?, instructions? }
   *   service:  { productCode, depositDate, orderNumber, commercialName? }
   *   options:  { insurance?, returnReceipt?, signed? }
   *
   * @returns {object} { trackingNumber, labelBase64, labelUrl, parcelNumber }
   */
  async generateLabel(token, { sender, recipient, parcel, service, options = {} }) {
    if (!token)     throw Object.assign(new Error('Token requis'), { status: 401 });
    if (!sender)    throw Object.assign(new Error('sender requis'), { status: 400 });
    if (!recipient) throw Object.assign(new Error('recipient requis'), { status: 400 });
    if (!parcel?.weight) throw Object.assign(new Error('parcel.weight requis'), { status: 400 });

    const body = {
      contractNumber: process.env.COLISSIMO_CONTRACT || '',
      password:       '', // vide si token utilisé
      outputFormat: {
        x:            0,
        y:            0,
        outputPrintingType: 'PDF_10x15_300dpi',
      },
      letter: {
        service: {
          productCode:    service?.productCode || SERVICES.DOM,
          depositDate:    service?.depositDate || _today(),
          mailBoxPicking: false,
          orderNumber:    service?.orderNumber || `TMT-${Date.now()}`,
          commercialName: service?.commercialName || 'TMT WEB',
          ...( options.returnReceipt ? { returnTypeChoice: '2' } : {} ),
        },
        parcel: {
          weight:          parcel.weight,
          ...(parcel.width  ? { width: parcel.width }   : {}),
          ...(parcel.height ? { height: parcel.height } : {}),
          ...(parcel.length ? { length: parcel.length } : {}),
          ...(options.insurance ? { insuranceValue: options.insurance, insuranceAmount: String(options.insurance) } : {}),
          ...(options.signed ? { recommendationLevel: 'R1' } : {}),
          instructions: parcel.instructions || '',
        },
        sender: {
          senderParcelRef: service?.orderNumber || '',
          address: {
            companyName: sender.companyName || '',
            lastName:    sender.lastName    || '',
            firstName:   sender.firstName   || '',
            line2:       sender.address,
            city:        sender.city,
            zipCode:     sender.zipCode,
            countryCode: sender.countryCode || 'FR',
            phoneNumber: sender.phone       || '',
            email:       sender.email       || '',
          },
        },
        addressee: {
          address: {
            companyName: recipient.companyName || '',
            lastName:    recipient.lastName    || '',
            firstName:   recipient.firstName   || '',
            line2:       recipient.address,
            city:        recipient.city,
            zipCode:     recipient.zipCode,
            countryCode: recipient.countryCode || 'FR',
            phoneNumber: recipient.phone       || '',
            mobileNumber: recipient.mobile     || '',
            email:       recipient.email       || '',
          },
        },
      },
    };

    const res = await _fetch(`${_base()}/sls-ws/SlsServiceWSRest/2.0/generateLabel`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'token':          token,
      },
      body: JSON.stringify(body),
    });

    // Colissimo retourne multipart : JSON header + PDF binary
    // En production : parser multipart. Ici on gère le JSON de contrôle.
    const contentType = res.headers.get('content-type') || '';

    let trackingNumber, labelBase64;

    if (contentType.includes('multipart')) {
      const rawBuf = await res.arrayBuffer();
      const raw    = Buffer.from(rawBuf).toString('binary');

      // Extraire le JSON de contrôle (première partie multipart)
      const jsonMatch = raw.match(/\{[\s\S]*?"messages"[\s\S]*?\}/);
      if (jsonMatch) {
        const ctrl = JSON.parse(jsonMatch[0]);
        if (ctrl.messages?.[0]?.type === 'ERROR') throw new Error(_parseErr(ctrl));
        trackingNumber = ctrl.labelResponse?.parcelNumber;
      }

      // Extraire le PDF (deuxième partie, binaire)
      const pdfStart = rawBuf.byteLength > 0 ? _extractPdf(Buffer.from(rawBuf)) : null;
      labelBase64    = pdfStart ? pdfStart.toString('base64') : null;

    } else {
      const d = await res.json();
      if (!res.ok) throw new Error(_parseErr(d));
      trackingNumber = d.labelResponse?.parcelNumber || d.parcelNumber;
      labelBase64    = d.labelResponse?.label || null;
    }

    if (!trackingNumber)
      throw new Error('Colissimo: numéro de suivi absent de la réponse');

    Logger.info('colissimo', 'LABEL_GENERATED', { trackingNumber });
    Logger.audit('LABEL_GENERATED', 'colissimo', { trackingNumber, recipient: recipient.zipCode });

    return {
      carrier:        'colissimo',
      trackingNumber,
      labelBase64,
      labelUrl:       `${ENDPOINTS.TRACKING}?code=${trackingNumber}`,
      trackingUrl:    `https://www.laposte.fr/outils/suivre-vos-envois?code=${trackingNumber}`,
    };
  },

  /**
   * Suivi d'un colis via l'API La Poste Suivi
   * Nécessite une clé API La Poste (différente des credentials Colissimo)
   * @param {string} trackingNumber
   * @param {string} apiKey — clé API developer.laposte.fr
   */
  async getTracking(trackingNumber, apiKey) {
    if (!trackingNumber) throw Object.assign(new Error('trackingNumber requis'), { status: 400 });

    // Sans clé API : retourner l'URL de suivi publique
    if (!apiKey) {
      return {
        trackingNumber,
        trackingUrl: `https://www.laposte.fr/outils/suivre-vos-envois?code=${trackingNumber}`,
        status:      'unknown',
        events:      [],
        note:        'Configurer LAPOSTE_API_KEY pour le suivi automatique',
      };
    }

    const res = await _fetch(`${ENDPOINTS.TRACKING_API}/${trackingNumber}`, {
      headers: {
        'Accept':  'application/json',
        'X-Okapi-Key': apiKey,
      },
    });

    if (res.status === 404) return { trackingNumber, status: 'not_found', events: [] };
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || 'Colissimo tracking error');

    const shipment = d.shipment;
    return {
      carrier:        'colissimo',
      trackingNumber,
      status:         _mapColissimoStatus(shipment?.event?.[0]?.code),
      statusLabel:    shipment?.event?.[0]?.label || '',
      estimatedDate:  shipment?.estimatedDeliveryDate || null,
      events:         (shipment?.event || []).map(e => ({
        date:    e.date,
        code:    e.code,
        label:   e.label,
        city:    e.postOfficeLabel || '',
        country: e.country || 'FR',
      })),
      trackingUrl: `https://www.laposte.fr/outils/suivre-vos-envois?code=${trackingNumber}`,
    };
  },

  /**
   * Vérifier et normaliser une adresse
   */
  async checkAddress(token, address) {
    const res = await _fetch(`${_base()}/sls-ws/SlsServiceWSRest/2.0/checkAddress`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'token': token },
      body:    JSON.stringify({ address }),
    });
    const d = await res.json();
    return { valid: res.ok && !d.messages?.some(m => m.type === 'ERROR'), normalized: d.address, messages: d.messages };
  },

  /**
   * Trouver les points de retrait proches d'un code postal
   */
  async getPickupPoints(postalCode, countryCode = 'FR') {
    const res = await _fetch(`${_base()}/pointretrait-ws-cxf/rest/pointsRetrait/findByZipCode/${postalCode}/${countryCode}`, {
      headers: { 'Accept': 'application/json' },
    });
    const d = await res.json();
    if (!res.ok) return [];
    return (d.listePointRetraitAcheminement || []).map(p => ({
      id:          p.identifiant,
      name:        p.nom,
      address:     p.adresse1,
      city:        p.localite,
      zipCode:     p.codePostal,
      lat:         p.coordGeolocalisationLatitude,
      lng:         p.coordGeolocalisationLongitude,
      openingDays: p.listeHoraireOuverture,
    }));
  },

  /** Test de connexion */
  async testConnection(creds) {
    try {
      const token = await ColissimoConnector.getToken(creds);
      return { ok: true, message: 'Connexion Colissimo établie', token: token.slice(0, 10) + '...' };
    } catch(e) {
      return { ok: false, message: e.message };
    }
  },
};

// ── Helpers privés ────────────────────────────────────────────
function _today() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '/');
}

function _extractPdf(buf) {
  const pdfSig = Buffer.from('%PDF');
  const idx    = buf.indexOf(pdfSig);
  return idx >= 0 ? buf.slice(idx) : null;
}

function _mapColissimoStatus(code) {
  if (!code) return 'unknown';
  const map = {
    'DR1': 'picked_up', 'ET1': 'in_transit', 'ET2': 'in_transit',
    'ET3': 'in_transit', 'ET4': 'in_transit', 'LV1': 'delivered',
    'AG1': 'out_for_delivery', 'MA1': 'out_for_delivery',
    'RE1': 'returned', 'RE2': 'returned', 'ITEM_OUT_CUSTODY': 'delivered',
  };
  return map[code] || 'in_transit';
}

module.exports = ColissimoConnector;
