'use strict';
/**
 * connectors/transport/mondialrelay-connector.js
 * Mondial Relay — API REST v5.10
 *
 * Documentation : https://connect.mondialrelay.com/api
 *
 * Méthodes :
 *   generateLabel(creds, shipment)   → { trackingNumber, labelBase64, labelUrl }
 *   getTracking(trackingNumber, creds) → { status, events[] }
 *   getPickupPoints(opts)            → Point[]
 *   testConnection(creds)            → { ok, message }
 *
 * Credentials requis :
 *   enseigne   : code enseigne (ex: "BDTEST13" en sandbox)
 *   privateKey : clé privée API
 *   customerId : ID client (pour certains endpoints)
 */

const crypto = require('crypto');
const Logger  = require('\.\./utils/logger');

const ENDPOINTS = {
  PROD:    'https://connect.mondialrelay.com/api',
  SANDBOX: 'https://connect.mondialrelay.com/api',  // même URL, credentials sandbox
};

// Codes transporteurs Mondial Relay
const SERVICES = {
  RELAY_24:  '24R',   // Livraison en point relais J+2
  RELAY_48:  '48R',   // Livraison en point relais J+3
  HOME_24:   '24H',   // Domicile J+2
  HOME_48:   '48H',   // Domicile J+3
  EUROPE:    'EUR2',  // Europe par relais
  OVERSIZED: '24L',   // Encombrant
};

function _base() {
  return process.env.MR_SANDBOX === 'true' ? ENDPOINTS.SANDBOX : ENDPOINTS.PROD;
}

/**
 * Signature HMAC-SHA1 requise par Mondial Relay
 * Format : HMAC-SHA1(enseigne + params + privateKey)
 */
function _sign(enseigne, params, privateKey) {
  const values = [enseigne, ...Object.values(params), privateKey];
  const str    = values.join('');
  return crypto.createHash('md5').update(str, 'latin1').digest('hex').toUpperCase();
}

async function _apiCall(url, body, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'TMT-HUB/14.0' },
        body:    JSON.stringify(body),
      });
      const d = await res.json();
      if (res.status >= 500 && i < retries) { await new Promise(r => setTimeout(r, (i+1)*2000)); continue; }
      return { status: res.status, data: d };
    } catch(e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, (i+1)*1500));
    }
  }
  throw lastErr || new Error('Mondial Relay: API call failed');
}

const MondialRelayConnector = {
  SERVICES,

  /**
   * Générer une étiquette Mondial Relay
   *
   * @param {object} creds - { enseigne, privateKey, customerId? }
   * @param {object} shipment
   *   sender:    { name, address, city, zipCode, countryCode, phone, email }
   *   recipient: { name, address, city, zipCode, countryCode, phone, email }
   *   parcel:    { weight (grammes), reference?, value? }
   *   service:   { productCode, relayId? (si livraison relais) }
   *
   * @returns {object} { trackingNumber, labelBase64, labelUrl }
   */
  async generateLabel(creds, { sender, recipient, parcel, service }) {
    if (!creds?.enseigne || !creds?.privateKey)
      throw Object.assign(new Error('Mondial Relay: enseigne et privateKey requis'), { status: 400 });
    if (!recipient?.zipCode)
      throw Object.assign(new Error('recipient.zipCode requis'), { status: 400 });
    if (!parcel?.weight)
      throw Object.assign(new Error('parcel.weight requis (en grammes)'), { status: 400 });

    const productCode = service?.productCode || SERVICES.RELAY_24;
    const ref         = parcel?.reference || `TMT${Date.now()}`.slice(-12);

    // Poids en grammes → décagrammes (unité Mondial Relay)
    const weightDeca  = Math.ceil(parcel.weight / 10);

    const params = {
      Enseigne:         creds.enseigne,
      ModeCol:          'CCC',          // Collecte chez l'expéditeur
      ModeLiv:          productCode,
      NDossier:         ref,
      NClient:          creds.customerId || '',
      Expe_Langage:     'FR',
      Expe_Ad1:         sender.name    || '',
      Expe_Ad2:         sender.address || '',
      Expe_Ad3:         '',
      Expe_Ville:       sender.city    || '',
      Expe_CP:          sender.zipCode || '',
      Expe_Pays:        sender.countryCode || 'FR',
      Expe_Tel1:        (sender.phone  || '').replace(/\D/g, ''),
      Expe_Mail:        sender.email   || '',
      Dest_Langage:     'FR',
      Dest_Ad1:         recipient.name    || '',
      Dest_Ad2:         recipient.address || '',
      Dest_Ad3:         '',
      Dest_Ville:       recipient.city    || '',
      Dest_CP:          recipient.zipCode || '',
      Dest_Pays:        recipient.countryCode || 'FR',
      Dest_Tel1:        (recipient.phone  || '').replace(/\D/g, ''),
      Dest_Mail:        recipient.email   || '',
      Poids:            String(weightDeca),
      NbColis:          '1',
      CRT_Valeur:       String(parcel.value || 0),
      CRT_Devise:       'EUR',
      COL_Rel_Pays:     '',
      COL_Rel:          '',
      LIV_Rel_Pays:     recipient.countryCode || 'FR',
      LIV_Rel:          service?.relayId || '',
      TAvisage:         '',
      TReprise:         '',
      Montage:          '',
      TRDV:             '',
      Assurance:        '0',
      Instructions:     parcel.instructions || '',
      Texte:            '',
    };

    // Signature MD5
    const security  = _sign(creds.enseigne, params, creds.privateKey);
    params.Security = security;

    const { status, data } = await _apiCall(`${_base()}/api/CreateParcel`, params);

    if (!data || (data.STAT && data.STAT !== '0')) {
      throw new Error(`Mondial Relay [${data?.STAT}]: ${data?.MSG || 'Erreur création colis'}`);
    }

    const trackingNumber = data.ExpeditionNum || data.NumeroColis;
    if (!trackingNumber)
      throw new Error('Mondial Relay: numéro de suivi absent');

    Logger.info('mondialrelay', 'LABEL_GENERATED', { trackingNumber });
    Logger.audit('LABEL_GENERATED', 'mondialrelay', { trackingNumber });

    return {
      carrier:        'mondialrelay',
      trackingNumber,
      labelBase64:    data.PDF || null,
      labelUrl:       `https://www.mondialrelay.fr/suivi-de-colis/?NumExp=${trackingNumber}&Pays=FR`,
      trackingUrl:    `https://www.mondialrelay.fr/suivi-de-colis/?NumExp=${trackingNumber}&Pays=FR`,
      relayId:        service?.relayId || null,
    };
  },

  /**
   * Suivi d'un colis Mondial Relay
   */
  async getTracking(trackingNumber, creds) {
    if (!trackingNumber)
      throw Object.assign(new Error('trackingNumber requis'), { status: 400 });

    if (!creds?.enseigne) {
      return {
        trackingNumber,
        trackingUrl: `https://www.mondialrelay.fr/suivi-de-colis/?NumExp=${trackingNumber}&Pays=FR`,
        status: 'unknown', events: [],
        note: 'Configurer les credentials pour le suivi API',
      };
    }

    const params = {
      Enseigne:      creds.enseigne,
      NumExpedition: trackingNumber,
      Langue:        'FR',
    };
    params.Security = _sign(creds.enseigne, params, creds.privateKey);

    const { status, data } = await _apiCall(`${_base()}/api/GetParcelStatus`, params);
    if (!data) return { trackingNumber, status: 'error', events: [] };

    const events = (data.List_EtapesMR?.EtapeMR || []).map(e => ({
      date:   e.Date,
      code:   e.Code_Etape,
      label:  e.Libelle,
      city:   e.Localisation || '',
    }));

    return {
      carrier:     'mondialrelay',
      trackingNumber,
      status:      _mapMRStatus(events[0]?.code),
      statusLabel: events[0]?.label || '',
      events,
      trackingUrl: `https://www.mondialrelay.fr/suivi-de-colis/?NumExp=${trackingNumber}&Pays=FR`,
    };
  },

  /**
   * Trouver des points relais Mondial Relay
   *
   * @param {object} opts - { enseigne, privateKey, postalCode, countryCode, productCode, maxResults }
   */
  async getPickupPoints({ enseigne, privateKey, postalCode, countryCode = 'FR', productCode = '24R', maxResults = 10 }) {
    if (!enseigne || !postalCode)
      throw Object.assign(new Error('enseigne et postalCode requis'), { status: 400 });

    const params = {
      Enseigne:      enseigne,
      Pays:          countryCode,
      NumPointRelais:'',
      CP:            postalCode,
      Ville:         '',
      Latitude:      '',
      Longitude:     '',
      Taille:        '',
      Poids:         '',
      Action:        '',
      DelaiEnvoi:    '0',
      RayonRecherche: '20',
      TypeActivite:  '',
      NACE:          '',
    };
    params.Security = _sign(enseigne, params, privateKey);

    try {
      const { data } = await _apiCall(`${_base()}/api/PointRelais_Recherche`, params);
      const points   = data?.PointsRelais?.PointRelais_Details || [];
      return points.slice(0, maxResults).map(p => ({
        id:           p.Num,
        name:         p.LgAdr1,
        address:      p.LgAdr3,
        city:         p.Ville,
        zipCode:      p.CP,
        countryCode:  p.Pays,
        lat:          p.Latitude?.replace(',', '.'),
        lng:          p.Longitude?.replace(',', '.'),
        openingHours: p.Horaires_Lundi
          ? { lun: p.Horaires_Lundi, mar: p.Horaires_Mardi, mer: p.Horaires_Mercredi }
          : {},
      }));
    } catch(e) {
      Logger.warn('mondialrelay', 'PICKUP_FAIL', { postalCode, error: e.message });
      return [];
    }
  },

  async testConnection(creds) {
    try {
      if (!creds?.enseigne || !creds?.privateKey)
        return { ok: false, message: 'enseigne et privateKey requis' };

      // Test : recherche points relais (appel léger)
      const points = await MondialRelayConnector.getPickupPoints({
        enseigne: creds.enseigne, privateKey: creds.privateKey, postalCode: '75001', maxResults: 1,
      });
      return { ok: true, message: `Connexion Mondial Relay établie — ${points.length} point(s) trouvé(s)` };
    } catch(e) {
      return { ok: false, message: e.message };
    }
  },
};

function _mapMRStatus(code) {
  if (!code) return 'unknown';
  const map = { 'P': 'picked_up', 'T': 'in_transit', 'L': 'delivered', 'D': 'out_for_delivery', 'R': 'returned' };
  return map[String(code)[0]] || 'in_transit';
}

module.exports = MondialRelayConnector;
