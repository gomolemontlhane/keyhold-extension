(function (global) {
  // ─── Text helpers ──────────────────────────────────────────────────────
  const cleanText = s => (s || '').replace(/\s+/g, ' ').trim();

  const extractNumber = s => {
    const match = String(s ?? '')
      .replace(/[\s,\u00a0]/g, '')
      .match(/\d+(\.\d+)?/);
    return match ? +match[0] : null;
  };

  const absoluteUrl = (url, base) => {
    try {
      return new URL(url, base).href;
    } catch (e) {
      return url || '';
    }
  };

  // ─── Normalisation ─────────────────────────────────────────────────────
  // Fill in gaps (beds, type, suburb, listingNo, id) inferred from the
  // title/URL so that tile and page extracts produce the same shape.
  function normalise(listing) {
    // Title like "3 Bedroom House ..." → beds + type
    const titleMatch = (listing.title || '')
      .match(/^(\d+(?:\.\d+)?)\s*bed(?:room)?s?\s+(.*)$/i);
    if (titleMatch) {
      listing.beds = listing.beds ?? +titleMatch[1];
      listing.type = listing.type || titleMatch[2];
    }
    listing.type = listing.type || cleanText(listing.title);

    // "/for-sale/suburb-name" or "/to-rent/suburb-name" → suburb
    const url = listing.url || '';
    const suburbMatch = url.match(/\/for-(?:sale|rent)\/([^/]+)/) ||
      url.match(/\/to-rent\/([^/]+)/);
    if (!listing.suburb && suburbMatch) {
      listing.suburb = suburbMatch[1]
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    }

    // Trailing numeric segment → listing number
    listing.listingNo = listing.listingNo ||
      (url.match(/\/(\d{6,})(?:\?|$)/) || [])[1] ||
      '';

    listing.id = listing.listingNo || listing.url;
    listing.source = 'property24';
    return listing;
  }

  // ─── Result-tile parser (search pages) ─────────────────────────────────
  function parseTile(tileEl, base) {
    const q = sel => tileEl.querySelector(sel);

    // Feature rows: <div class=p24_featureDetails title="Bedrooms">
    const featureNumber = name => {
      const el = [...tileEl.querySelectorAll('.p24_featureDetails')]
        .find(x => (x.getAttribute('title') || '').toLowerCase().startsWith(name));
      return el ? extractNumber(el.textContent) : null;
    };

    const link = q('a[href*="/for-sale/"],a[href*="/to-rent/"]');
    const image = q('img.js_P24_listingImage') || q('.p24_image img');
    const priceEl = q('.p24_price');
    const titleEl = q('.p24_title');
    const locationEl = q('.p24_location');
    const addressEl = q('.p24_address');
    const excerptEl = q('.p24_excerpt');
    const brandEl = q('.p24_branding img');

    return normalise({
      listingNo: tileEl.getAttribute('data-listing-number'),
      url: absoluteUrl(link && link.getAttribute('href'), base).split('?')[0],
      title: cleanText(titleEl && titleEl.textContent),
      price: extractNumber(priceEl && (priceEl.getAttribute('content') || priceEl.textContent)),
      suburb: cleanText(locationEl && locationEl.textContent),
      address: cleanText(addressEl && addressEl.textContent),
      desc: cleanText(excerptEl && excerptEl.textContent),
      beds: featureNumber('bed'),
      baths: featureNumber('bath'),
      parking: featureNumber('parking'),
      size: featureNumber('erf') || featureNumber('floor'),
      img: image ? absoluteUrl(image.getAttribute('src') || image.getAttribute('data-src'), base) : '',
      agent: cleanText(brandEl && brandEl.alt),
    });
  }

  // ─── Single-listing page parser ────────────────────────────────────────
  function parsePage(doc, base) {
    const og = prop =>
      (doc.querySelector(`meta[property="og:${prop}"]`) || {}).content || '';

    const canonicalEl = doc.querySelector('link[rel=canonical]');
    const url = (canonicalEl && canonicalEl.href || og('url') || base || '').split('?')[0];

    const bodyText = cleanText(doc.body && doc.body.textContent).slice(0, 80000);
    const fromBody = regex => {
      const m = bodyText.match(regex);
      return m ? extractNumber(m[1]) : null;
    };

    const h1 = doc.querySelector('h1');
    const priceEl = doc.querySelector('[itemprop=price],.p24_price');
    const agencyEl = doc.querySelector('.p24_agencyName,[itemprop=RealEstateAgent] [itemprop=name]');
    const descEl = doc.querySelector('.js_readMoreText,.p24_description');

    return normalise({
      url,
      title: cleanText(h1 && h1.textContent) || og('title').split(':')[0].trim(),
      price: extractNumber(priceEl && (priceEl.getAttribute('content') || priceEl.textContent)) ||
        fromBody(/\bR\s?(\d[\d ]{4,})/),
      desc: cleanText(descEl && descEl.textContent || og('description')).slice(0, 600),
      beds: fromBody(/(\d+)\s*Bed/i),
      baths: fromBody(/(\d+(?:\.\d)?)\s*Bath/i),
      parking: fromBody(/(\d+)\s*(?:Parking|Garage)/i),
      size: fromBody(/([\d ]{2,})\s*m²/),
      img: og('image'),
      agent: cleanText(agencyEl && agencyEl.textContent),
    });
  }

  // ─── Public API ────────────────────────────────────────────────────────
  global.P24 = {
    /**
     * Extract listings from a parsed Property24 document.
     * @param {Document} doc  - DOM of the page
     * @param {string}   base - Base URL for resolving relative links
     * @returns {Array<Object>} normalised listings
     */
    extract(doc, base) {
      const tiles = [...doc.querySelectorAll('.js_resultTile[data-listing-number]')];
      if (tiles.length) {
        return tiles
          .map(t => parseTile(t, base))
          .filter(listing => listing.id);
      }

      const single = parsePage(doc, base);
      return single.id && (single.title || single.price) ? [single] : [];
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);