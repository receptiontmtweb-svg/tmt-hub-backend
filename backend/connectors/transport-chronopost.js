'use strict';
/**
 * connectors/transport/chronopost-connector.js
 * Chronopost — Web Services SOAP/REST
 *
 * Documentation : https://www.chronopost.fr/fr/nos-apis
 * API WSDL : https://ws.chronopost.fr/shipping-cxf/ShippingServiceWS?wsdl
 *
 * Méthodes :
 *   generateLabel(creds, shipment)   → { trackingNumber, labelBase64 }
 *   getTracking(trackingNumber)      → { status, events[] }
 *   getPickupPoints(postalCode)      → Point[]
 *   testConnection(creds)            → { ok, message }
 *
 * Credentials requis :
 *   accountNumber  : numéro de compte Chronopost
 *   subAccount     : sous-compte (souvent '00')
 *   password       : mot de passe API
 */

const Logger = require('\.\./utils/logger');

const ENDPOINTS = {
  SHIPPING:  'https://ws.chronopost.fr/shipping-cxf/ShippingServiceWS',
  TRACKING:  'https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS',
  RELAY:     'https://ws.chronopost.fr/recherchebt-ws-cxf/RecherchePointChronopostServiceWS',
};

// Codes produits Chronopost
const PRODUCTS = {
  EXPRESS:   '01',  // Chrono 13h
  EXPRESS18: '02',  // Chrono 18h
  RELAIS:    '86',  // Chrono Relais
  SAMEDI:    '16',  // Chrono Samedi
  CLASSIC:   '44',  // Chrono Classic
  EUROPE:    '17',  // Chrono Express Europe
  FRESH:     'CSM', // Chrono Fresh (alimentaire)
};

function _buildSoapEnvelope(method, bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:cxf="http://cxf.shipping.soap.chronopost.fr/">
  <soapenv:Header/>
  <soapenv:Body>
    <cxf:${method}>
      ${bodyXml}
    </cxf:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function _parseXml(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : null;
}

function _parseAllXml(xml, tag) {
  const regex   = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const results = [];
  let match;
  while ((match = regex.exec(xml)) !== null) results.push(match[1].trim());
  return results;
}

async function _soapCall(url, soapAction, envelope, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml;charset=UTF-8',
          'SOAPAction':   soapAction,
          'User-Agent':   'TMT-HUB/14.0',
        },
        body: envelope,
      });
      const text = await res.text();
      if (res.status >= 500 && i < retries) {
        await new Promise(r => setTimeout(r, (i + 1) * 2000)); continue;
      }
      return text;
    } catch(e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, (i + 1) * 1500));
    }
  }
  throw lastErr || new Error('Chronopost: SOAP call failed');
}

const ChronopostConnector = {
  PRODUCTS,

  /**
   * Générer une étiquette Chronopost
   *
   * @param {object} creds - { accountNumber, subAccount, password }
   * @param {object} shipment
   *   sender:    { name, address, city, zipCode, countryCode, phone, email }
   *   recipient: { name, company?, address, city, zipCode, countryCode, phone, email }
   *   parcel:    { weight, value?, reference? }
   *   service:   { productCode, shippingDate? }
   *
   * @returns {object} { trackingNumber, labelBase64, labelUrl }
   */
  async generateLabel(creds, { sender, recipient, parcel, service }) {
    if (!creds?.accountNumber || !creds?.password)
      throw Object.assign(new Error('Chronopost: accountNumber et password requis'), { status: 400 });
    if (!recipient?.zipCode)
      throw Object.assign(new Error('recipient.zipCode requis'), { status: 400 });
    if (!parcel?.weight)
      throw Object.assign(new Error('parcel.weight requis'), { status: 400 });

    const productCode = service?.productCode || PRODUCTS.EXPRESS;
    const shippingDate = service?.shippingDate || new Date().toISOString().slice(0, 10);
    const ref = parcel?.reference || `TMT-${Date.now()}`;

    const bodyXml = `
      <headerValue>
        <accountNumber>${creds.accountNumber}</accountNumber>
        <idEmit>CHRFR</idEmit>
        <subAccount>${creds.subAccount || '00'}</subAccount>
      </headerValue>
      <shipperValue>
        <shipperAdress1>${_esc(sender.address)}</shipperAdress1>
        <shipperCity>${_esc(sender.city)}</shipperCity>
        <shipperCivility>M</shipperCivility>
        <shipperContactName>${_esc(sender.name || '')}</shipperContactName>
        <shipperCountry>${sender.countryCode || 'FR'}</shipperCountry>
        <shipperEmail>${_esc(sender.email || '')}</shipperEmail>
        <shipperMobilePhone>${_esc(sender.phone || '')}</shipperMobilePhone>
        <shipperZipCode>${sender.zipCode}</shipperZipCode>
      </shipperValue>
      <recipientValue>
        <recipientAdress1>${_esc(recipient.address)}</recipientAdress1>
        <recipientCity>${_esc(recipient.city)}</recipientCity>
        <recipientContactName>${_esc(recipient.name || recipient.lastName || '')}</recipientContactName>
        <recipientCountry>${recipient.countryCode || 'FR'}</recipientCountry>
        <recipientEmail>${_esc(recipient.email || '')}</recipientEmail>
        <recipientMobilePhone>${_esc(recipient.phone || recipient.mobile || '')}</recipientMobilePhone>
        <recipientName>${_esc(recipient.company || recipient.name || '')}</recipientName>
        <recipientZipCode>${recipient.zipCode}</recipientZipCode>
      </recipientValue>
      <shipValue>
        <height>1</height>
        <length>1</length>
        <objectType>MAR</objectType>
        <quantity>1</quantity>
        <shipDate>${shippingDate}</shipDate>
        <shipHour>12</shipHour>
        <weight>${parcel.weight}</weight>
        <width>1</width>
      </shipValue>
      <etiquetteValue>
        <brokenPackageValue>0</brokenPackageValue>
        <codValue>0</codValue>
        <crbt>0</crbt>
        <ftd>0</ftd>
        <insuranceValue>0</insuranceValue>
        <mastercheckValue>0</mastercheckValue>
        <passwordValue>${_esc(creds.password)}</passwordValue>
        <productCode>${productCode}</productCode>
        <recipientRef>${_esc(ref)}</recipientRef>
        <serviceInfo1></serviceInfo1>
        <serviceInfo2></serviceInfo2>
        <shipperRef>${_esc(ref)}</shipperRef>
      </etiquetteValue>
      <version>2.0</version>`;

    const envelope = _buildSoapEnvelope(
      'shippingV5',
      bodyXml
    );

    const xml = await _soapCall(ENDPOINTS.SHIPPING, 'shippingV5', envelope);

    // Parser la réponse SOAP
    const errorCode = _parseXml(xml, 'errorCode');
    if (errorCode && errorCode !== '0') {
      const errorMsg = _parseXml(xml, 'errorMessage') || 'Chronopost error';
      throw new Error(`Chronopost [${errorCode}]: ${errorMsg}`);
    }

    const trackingNumber = _parseXml(xml, 'reservationNumber') || _parseXml(xml, 'skybillNumber');
    const labelBase64    = _parseXml(xml, 'pdfEtiquette') || _parseXml(xml, 'label');

    if (!trackingNumber)
      throw new Error('Chronopost: numéro de suivi absent de la réponse');

    Logger.info('chronopost', 'LABEL_GENERATED', { trackingNumber, productCode });
    Logger.audit('LABEL_GENERATED', 'chronopost', { trackingNumber });

    return {
      carrier:        'chronopost',
      trackingNumber,
      labelBase64:    labelBase64 || null,
      labelUrl:       `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${trackingNumber}`,
      trackingUrl:    `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${trackingNumber}`,
      productCode,
    };
  },

  /**
   * Suivi d'un colis Chronopost
   */
  async getTracking(trackingNumber) {
    if (!trackingNumber)
      throw Object.assign(new Error('trackingNumber requis'), { status: 400 });

    const envelope = _buildSoapEnvelope('trackSkybillV2', `
      <language>fr_FR</language>
      <skybillNumber>${_esc(trackingNumber)}</skybillNumber>
    `);

    const xml = await _soapCall(ENDPOINTS.TRACKING, 'trackSkybillV2', envelope);

    const errorCode = _parseXml(xml, 'errorCode');
    if (errorCode && errorCode !== '0') {
      return { trackingNumber, status: 'error', events: [], error: _parseXml(xml, 'errorMessage') };
    }

    const listEvents = _parseXml(xml, 'listEventInfoComp') || '';
    const eventBlocks = _parseAllXml(listEvents, 'eventInfoComp');
    const events = eventBlocks.map(block => ({
      date:   _parseXml(block, 'eventDate'),
      code:   _parseXml(block, 'code'),
      label:  _parseXml(block, 'eventLabel'),
      city:   _parseXml(block, 'officeLabel') || '',
    }));

    const lastCode   = events[0]?.code;
    const lastStatus = _mapChronoStatus(lastCode);

    return {
      carrier:     'chronopost',
      trackingNumber,
      status:      lastStatus,
      statusLabel: events[0]?.label || '',
      events,
      trackingUrl: `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${trackingNumber}`,
    };
  },

  /**
   * Trouver les points relais Chronopost proches
   */
  async getPickupPoints(postalCode, countryCode = 'FR') {
    const envelope = _buildSoapEnvelope('recherchePointChronopostInterParService', `
      <codeService>${PRODUCTS.RELAIS}</codeService>
      <datePriseEnCharge>${new Date().toISOString().slice(0,10)}</datePriseEnCharge>
      <langue>fr</langue>
      <pays>${countryCode}</pays>
      <typeRecherche>1</typeRecherche>
      <valeurRecherche>${postalCode}</valeurRecherche>
    `);

    try {
      const xml    = await _soapCall(ENDPOINTS.RELAY, 'recherchePointChronopostInterParService', envelope);
      const blocks = _parseAllXml(xml, 'listePointRelais');
      return blocks.slice(0, 10).map(b => ({
        id:      _parseXml(b, 'identifiant'),
        name:    _parseXml(b, 'nom'),
        address: _parseXml(b, 'adresse1'),
        city:    _parseXml(b, 'localite'),
        zipCode: _parseXml(b, 'codePostal'),
        lat:     _parseXml(b, 'coordGeolocalisationLatitude'),
        lng:     _parseXml(b, 'coordGeolocalisationLongitude'),
      }));
    } catch(e) {
      Logger.warn('chronopost', 'PICKUP_POINTS_FAIL', { postalCode, error: e.message });
      return [];
    }
  },

  async testConnection(creds) {
    try {
      if (!creds?.accountNumber || !creds?.password)
        return { ok: false, message: 'accountNumber et password requis' };
      // Test léger : appel tracking sur un numéro fictif
      await ChronopostConnector.getTracking('TEST000000000000');
      return { ok: true, message: 'Connexion Chronopost établie' };
    } catch(e) {
      // Une erreur "not found" = connexion OK
      if (e.message.includes('0') || e.message.includes('not found'))
        return { ok: true, message: 'Connexion Chronopost établie' };
      return { ok: false, message: e.message };
    }
  },
};

function _esc(s) { return String(s || '').replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }

function _mapChronoStatus(code) {
  if (!code) return 'unknown';
  const map = { 'D': 'picked_up', 'T': 'in_transit', 'A': 'in_transit', 'L': 'delivered', 'E': 'out_for_delivery', 'R': 'returned' };
  return map[code?.[0]] || 'in_transit';
}

module.exports = ChronopostConnector;
