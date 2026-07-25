// ============================================================================
// COUNTY CONFIG — this is the only file you need to touch to add a new NC
// county's own GIS service (for richer tax/sale data than the statewide
// fallback provides).
//
// HOW TO ADD A COUNTY:
//   1. Find the county's ArcGIS REST parcel layer (ask Claude to research it,
//      the same way Buncombe's was researched below).
//   2. Copy the BUNCOMBE block, rename the key to the county name EXACTLY as
//      it appears in NC OneMap's "cntyname" field (all caps, e.g. "MOORE").
//   3. Update serviceUrl and the map() function's field names to match that
//      county's service.
//   4. Save. No other file needs to change.
//
// If a county has no entry here, the app automatically falls back to the
// statewide NC OneMap layer (DEFAULT_CONFIG below), which covers all 100 NC
// counties but with fewer fields (no sale price, no separate land/building
// breakdown).
// ============================================================================

function money(value) {
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  if (value === null || value === undefined || value === '' || isNaN(n)) return null;
  return n;
}

function esriDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  const str = String(value).trim();
  // Buncombe's DeedDate comes back as "YYYYMMDD" text, not a real Date type
  const yyyymmdd = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (yyyymmdd) {
    const d = new Date(Number(yyyymmdd[1]), Number(yyyymmdd[2]) - 1, Number(yyyymmdd[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

const DEFAULT_CONFIG = {
  label: 'NC OneMap (statewide)',
  serviceUrl: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1/query',
  outFields: ['parno', 'ownname', 'ownname2', 'siteadd', 'gisacres', 'parval', 'landval', 'improvval', 'saledate', 'cntyname'],
  map(attrs) {
    return {
      owner: attrs.ownname ? [attrs.ownname, attrs.ownname2].filter(Boolean).join(' / ') : null,
      apn: attrs.parno || null,
      address: attrs.siteadd || null,
      acreage: money(attrs.gisacres),
      taxValue: money(attrs.parval),
      annualTax: undefined, // not published by any free NC GIS/tax source — see app note
      salePrice: null, // not present in the statewide layer
      saleDate: esriDate(attrs.saledate),
      county: attrs.cntyname || null,
    };
  },
};

const COUNTY_CONFIGS = {
  BUNCOMBE: {
    label: 'Buncombe County GIS',
    serviceUrl: 'https://gis.buncombecounty.org/arcgis/rest/services/opendata/MapServer/1/query',
    outFields: [
      'PIN', 'Owner', 'HouseNumber', 'StreetPrefix', 'StreetName', 'StreetType', 'StreetPostDirection',
      'Address', 'CityName', 'State', 'Zipcode', 'Acreage', 'TotalMarketValue', 'TaxValue', 'LandValue',
      'BuildingValue', 'SalePrice', 'DeedDate', 'County',
    ],
    map(attrs) {
      const siteParts = [attrs.HouseNumber, attrs.StreetPrefix, attrs.StreetName, attrs.StreetType, attrs.StreetPostDirection]
        .map((p) => (p || '').toString().trim())
        .filter(Boolean);
      const address = siteParts.length
        ? siteParts.join(' ')
        : [attrs.Address, attrs.CityName, [attrs.State, attrs.Zipcode].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;

      const salePrice = money(attrs.SalePrice);
      return {
        owner: attrs.Owner || null,
        apn: attrs.PIN || null,
        address,
        acreage: money(attrs.Acreage),
        taxValue: money(attrs.TotalMarketValue) ?? money(attrs.TaxValue),
        annualTax: undefined, // county publishes assessed value, not the billed $ amount, via free GIS — see app note
        salePrice: salePrice !== null && salePrice <= 100 ? { amount: salePrice, nominal: true } : (salePrice !== null ? { amount: salePrice, nominal: false } : null),
        saleDate: esriDate(attrs.DeedDate),
        county: attrs.County || 'BUNCOMBE',
      };
    },
  },
};

function getCountyConfig(countyName) {
  if (!countyName) return null;
  return COUNTY_CONFIGS[countyName.trim().toUpperCase()] || null;
}
