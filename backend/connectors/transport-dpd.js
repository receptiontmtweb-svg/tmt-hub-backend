'use strict';
/**
 * connectors/transport/dpd-connector.js
 * DPD France — ShipperService SOAP + myDPD API
 *
 * Documentation : https://esolutions.dpd.com/entwickler/dpd_webservices.aspx
 * WSDL : https://wsshipper.dpd.fr/soap11/ShipperService?wsdl
 *
 * Méthodes :
 *   generateLabel(creds, shipment)  → { trackingNumber, labelBase64, labelUrl }
 *   getTracking(trackingNumber)     → { status, events[] }
 *   getPickupPoints(postalCode)     → Point[]
 *   testConnection(creds)           → { ok, message }
 *
 * Credentials requis :
 *   login          : identifiant DPD (généralement le n° de compte)
 *   password       : mot de passe
 *   customerNumber : numéro client DPD
 *   depot          : code dépôt (optionnel, souvent '60')
 */

const Logger = require('\.\./utils/logger');

const ENDPOINTS = {
  PROD:     'https://wsshipper.dpd.fr/soap11/ShipperService',
  SANDBOX:  'https://wsshipper.dpd.fr/soap11/ShipperService',  // DPD teste sur prod avec compte test
  TRACKING: 'https://tracking.dpd.fr/api/',
  RELAY:    'https://wsshipper.dpd.fr/soap11/PickupLocationService',
};

const PRODUCTS = {
  CLASSIC:     'Classic',     // DPD Classic J+1
  PREDICT:     'Predict',     // DPD Predict (notification SMS)
  RELAIS:      'Pickup',      // DPD Pickup (point relais)
  EXPRESS:     'Express',     // Express 10h / 12h
  RETURN:      'Return',      // Retour colis
};

function _buildSoapEnvelope(method, ns, bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:ns="${ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:${method}>
      ${bodyXml}
    </ns:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function _parseXml(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`));
  return m ? m[1].trim() : null;
}

async function _soapCall(url, soapAction, body, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `"${soapAction}"`, 'User-Agent': 'TMT-HUB/14.0' },
        body,
      });
      const text = await res.text();
      if (res.status >= 500 && i < retries) { await new Promise(r => setTimeout(r,(i+1)*2000)); continue; }
      return text;
    } catch(e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, (i+1)*1500));
    }
  }
  throw lastErr || new Error('DPD: SOAP call failed');
}

const DPDConnector = {
  PRODUCTS,

  /**
   * Générer une étiquette DPD
   *
   * @param {object} creds - { login, password, customerNumber, depot? }
   * @param {object} shipment
   *   sender:    { name, address, city, zipCode, countryCode, phone, email }
   *   recipient: { name, company?, address, city, zipCode, countryCode, phone, email }
   *   parcel:    { weight (kg), reference?, value? }
   *   service:   { productCode }
   *
   * @returns {object} { trackingNumber, labelBase64, labelUrl }
   */
  async generateLabel(creds, { sender, recipient, parcel, service }) {
    if (!creds?.login || !creds?.password || !creds?.customerNumber)
      throw Object.assign(new Error('DPD: login, password et customerNumber requis'), { status: 400 });
    if (!recipient?.zipCode)
      throw Object.assign(new Error('recipient.zipCode requis'), { status: 400 });
    if (!parcel?.weight)
      throw Object.assign(new Error('parcel.weight requis (en kg)'), { status: 400 });

    const productCode = service?.productCode || PRODUCTS.CLASSIC;
    const ref         = parcel?.reference || `TMT${Date.now()}`.slice(-10);

    const bodyXml = `
      <CreateShipmentOrder>
        <shipmentOrderList>
          <generalShipmentData>
            <mpsCustomerReferenceNumber>${ref}</mpsCustomerReferenceNumber>
            <product>${productCode}</product>
            <sender>
              <type>B</type>
              <name1>${_esc(sender.name || '')}</name1>
              <street>${_esc(sender.address || '')}</street>
              <zipCode>${sender.zipCode}</zipCode>
              <city>${_esc(sender.city || '')}</city>
              <country>${sender.countryCode || 'FR'}</country>
              <phone>${(sender.phone||'').replace(/\D/g,'')}</phone>
              <email>${_esc(sender.email||'')}</email>
            </sender>
            <recipient>
              <type>${recipient.company ? 'B' : 'P'}</type>
              <name1>${_esc(recipient.name || '')}</name1>
              <name2>${_esc(recipient.company || '')}</name2>
              <street>${_esc(recipient.address || '')}</street>
              <zipCode>${recipient.zipCode}</zipCode>
              <city>${_esc(recipient.city || '')}</city>
              <country>${recipient.countryCode || 'FR'}</country>
              <phone>${(recipient.phone||recipient.mobile||'').replace(/\D/g,'')}</phone>
              <email>${_esc(recipient.email||'')}</email>
            </recipient>
          </generalShipmentData>
          <parcels>
            <customerReferenceNumber1>${ref}</customerReferenceNumber1>
            <weight>${parcel.weight}</weight>
          </parcels>
          <productAndServiceData>
            <orderType>consignment</orderType>
            <saturdayDelivery>false</saturdayDelivery>
          </productAndServiceData>
        </shipmentOrderList>
        <printOptions>
          <paperFormat>A6</paperFormat>
          <printAssistant>false</printAssistant>
          <startPosition>UpperLeft</startPosition>
        </printOptions>
        <login>
          <login>${_esc(creds.login)}</login>
          <password>${_esc(creds.password)}</password>
          <depot>${creds.depot || '60'}</depot>
        </login>
      </CreateShipmentOrder>`;

    const envelope = _buildSoapEnvelope('CreateShipmentOrder',
      'http://dpd.com/common/service/ShipperServiceV3_3',
      bodyXml
    );

    const xml = await _soapCall(ENDPOINTS.PROD, 'CreateShipmentOrder', envelope);

    const fault = _parseXml(xml, 'faultstring');
    if (fault) throw new Error(`DPD SOAP fault: ${fault}`);

    const ack    = _parseXml(xml, 'acknowledgement');
    const errCode = _parseXml(ack || xml, 'type');
    if (errCode === 'Error') {
      const errMsg = _parseXml(ack || xml, 'content');
      throw new Error(`DPD [Error]: ${errMsg}`);
    }

    const trackingNumber = _parseXml(xml, 'parcelnumber') || _parseXml(xml, 'shipmentTrackingNumber');
    const labelBase64    = _parseXml(xml, 'label') || _parseXml(xml, 'content');

    if (!trackingNumber)
      throw new Error('DPD: numéro de suivi absent de la réponse');

    Logger.info('dpd', 'LABEL_GENERATED', { trackingNumber });
    Logger.audit('LABEL_GENERATED', 'dpd', { trackingNumber });

    return {
      carrier:        'dpd',
      trackingNumber,
      labelBase64:    labelBase64 || null,
      labelUrl:       `https://tracking.dpd.fr/parcels/fr/parcel/${trackingNumber}`,
      trackingUrl:    `https://tracking.dpd.fr/parcels/fr/parcel/${trackingNumber}`,
      productCode,
    };
  },

  /**
   * Suivi d'un colis DPD via l'API REST myDPD
   */
  async getTracking(trackingNumber) {
    if (!trackingNumber)
      throw Object.assign(new Error('trackingNumber requis'), { status: 400 });

    try {
      const res = await fetch(`${ENDPOINTS.TRACKING}${trackingNumber}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'TMT-HUB/14.0' },
      });

      if (res.status === 404) return { trackingNumber, status: 'not_found', events: [] };
      if (!res.ok)            return { trackingNumber, status: 'error', events: [] };

      const d      = await res.json();
      const events = (d.trackSummary?.parcels?.[0]?.events || []).map(e => ({
        date:   e.eventDate,
        code:   e.eventCode,
        label:  e.eventDescription,
        city:   e.location?.city || '',
      }));

      return {
        carrier:     'dpd',
        trackingNumber,
        status:      _mapDPDStatus(events[0]?.code),
        statusLabel: events[0]?.label || '',
        estimatedDate: d.trackSummary?.parcels?.[0]?.deliveryDate || null,
        events,
        trackingUrl: `https://tracking.dpd.fr/parcels/fr/parcel/${trackingNumber}`,
      };
    } catch(e) {
      Logger.warn('dpd', 'TRACKING_FAIL', { trackingNumber, error: e.message });
      return {
        trackingNumber,
        status: 'unknown',
        events: [],
        trackingUrl: `https://tracking.dpd.fr/parcels/fr/parcel/${trackingNumber}`,
      };
    }
  },

  /**
   * Points de retrait DPD Pickup
   */
  async getPickupPoints(postalCode, countryCode = 'FR') {
    try {
      const res = await fetch(
        `https://wsshipper.dpd.fr/soap11/PickupLocationService?countryCode=${countryCode}&zipCode=${postalCode}&limit=10`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (!res.ok) return [];
      const d = await res.json();
      return (d.pickupLocationList || []).map(p => ({
        id:      p.parcelShopId,
        name:    p.company,
        address: p.street,
        city:    p.city,
        zipCode: p.zipCode,
        country: p.countryCode,
        lat:     p.geoPosition?.latitude,
        lng:     p.geoPosition?.longitude,
      }));
    } catch(e) {
      return [];
    }
  },

  async testConnection(creds) {
    if (!creds?.login || !creds?.password || !creds?.customerNumber)
      return { ok: false, message: 'login, password et customerNumber requis' };
    // Validation locale des credentials (pas d'appel de test gratuit DPD)
    return {
      ok:      true,
      message: 'Credentials DPD configurés — test réel lors de la première étiquette',
      note:    'DPD ne propose pas d\'endpoint de test dédié sans générer une vraie étiquette',
    };
  },
};

function _esc(s) {
  return String(s || '').replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
}

function _mapDPDStatus(code) {
  if (!code) return 'unknown';
  const map = {
    'PickedUp': 'picked_up', 'InTransit': 'in_transit',
    'AtDeliveryDepot': 'out_for_delivery', 'Delivered': 'delivered',
    'Exception': 'failed', 'Return': 'returned',
  };
  return map[code] || 'in_transit';
}

module.exports = DPDConnector;
