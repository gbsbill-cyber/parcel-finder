const RADII_METERS = [800, 2000, 5000, 15000, 40000, 100000];
const RESULT_COUNT = 4;

const screens = {
  start: document.getElementById('screen-start'),
  loading: document.getElementById('screen-loading'),
  results: document.getElementById('screen-results'),
  map: document.getElementById('screen-map'),
  error: document.getElementById('screen-error'),
};

let currentParcels = [];
let leafletMap = null;

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ringsCentroid(rings) {
  if (!rings || !rings.length) return null;
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      sumLon += lon;
      sumLat += lat;
      count++;
    }
  }
  if (!count) return null;
  return { lat: sumLat / count, lon: sumLon / count };
}

async function queryNearestFeatures(config, lat, lon) {
  let lastFeatures = [];
  for (const distance of RADII_METERS) {
    const params = new URLSearchParams({
      geometry: `${lon},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      distance: String(distance),
      units: 'esriSRUnit_Meter',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: config.outFields.join(','),
      returnGeometry: 'true',
      outSR: '4326',
      f: 'json',
    });
    const resp = await fetch(`${config.serviceUrl}?${params.toString()}`);
    if (!resp.ok) throw new Error(`GIS service returned an error (${resp.status}). Try again in a moment.`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || 'GIS service returned an error.');
    lastFeatures = data.features || [];
    if (lastFeatures.length >= RESULT_COUNT) return lastFeatures;
  }
  return lastFeatures;
}

function featuresToParcels(config, features, userLat, userLon) {
  return features
    .map((f) => {
      const centroid = ringsCentroid(f.geometry && f.geometry.rings);
      if (!centroid) return null;
      const distanceMeters = haversineMeters(userLat, userLon, centroid.lat, centroid.lon);
      return {
        ...config.map(f.attributes),
        centroid,
        distanceMeters,
        rings: f.geometry.rings,
        sourceLabel: config.label,
      };
    })
    .filter(Boolean);
}

async function findNearestParcels(lat, lon) {
  const statewideFeatures = await queryNearestFeatures(DEFAULT_CONFIG, lat, lon);
  let parcels = featuresToParcels(DEFAULT_CONFIG, statewideFeatures, lat, lon);

  const nearestCounty = parcels.length ? parcels.slice().sort((a, b) => a.distanceMeters - b.distanceMeters)[0].county : null;
  const override = getCountyConfig(nearestCounty);

  if (override) {
    try {
      const overrideFeatures = await queryNearestFeatures(override, lat, lon);
      const overrideParcels = featuresToParcels(override, overrideFeatures, lat, lon);
      if (overrideParcels.length >= Math.min(RESULT_COUNT, parcels.length || RESULT_COUNT)) {
        parcels = overrideParcels;
      }
    } catch (e) {
      // county-specific service failed — silently keep the statewide results
    }
  }

  parcels.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return parcels.slice(0, RESULT_COUNT);
}

function formatDistance(meters) {
  const feet = meters * 3.28084;
  if (feet < 1000) return `${Math.round(feet)} ft`;
  return `${(meters / 1609.34).toFixed(2)} mi`;
}

function formatMoney(value) {
  if (value === null || value === undefined || isNaN(value) || value === 0) return 'Not available';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function formatAcres(value) {
  if (value === null || value === undefined || isNaN(value) || value === 0) return 'Not available';
  return `${value.toFixed(2)} acres`;
}

function formatSalePrice(salePrice) {
  if (!salePrice || salePrice.amount === null || salePrice.amount === undefined) return 'Not available';
  if (salePrice.nominal) return 'Not available (nominal transfer on record, not a market sale)';
  return formatMoney(salePrice.amount);
}

function formatDate(d) {
  if (!d) return 'Not available';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function row(label, value) {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const l = document.createElement('span');
  l.className = 'row-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'row-value';
  v.textContent = value;
  wrap.append(l, v);
  return wrap;
}

function renderResults(parcels) {
  const list = document.getElementById('results-list');
  list.innerHTML = '';

  parcels.forEach((p, i) => {
    const card = document.createElement('button');
    card.className = 'card';
    card.type = 'button';
    card.addEventListener('click', () => openMap(i));

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = p.owner || 'Owner not on record';
    card.appendChild(title);

    const dist = document.createElement('div');
    dist.className = 'card-distance';
    dist.textContent = formatDistance(p.distanceMeters);
    card.appendChild(dist);

    card.appendChild(row('Parcel ID (APN)', p.apn || 'Not available'));
    card.appendChild(row('Address', p.address || 'Not available'));
    card.appendChild(row('Acreage', formatAcres(p.acreage)));
    card.appendChild(row('Tax-assessed value', formatMoney(p.taxValue)));
    card.appendChild(row('Annual property tax', 'Not publicly available (see note below)'));
    card.appendChild(
      row('Last sale price', formatSalePrice(p.salePrice))
    );
    card.appendChild(row('Last sale date', formatDate(p.saleDate)));
    card.appendChild(row('Data source', p.sourceLabel));

    const tapHint = document.createElement('div');
    tapHint.className = 'tap-hint';
    tapHint.textContent = 'Tap to view on map ›';
    card.appendChild(tapHint);

    list.appendChild(card);
  });

  showScreen('results');
}

function openMap(index) {
  const p = currentParcels[index];
  showScreen('map');
  document.getElementById('map-title').textContent = p.owner || 'Parcel';
  document.getElementById('map-subtitle').textContent = p.address || p.apn || '';

  const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${p.centroid.lat},${p.centroid.lon}`;
  document.getElementById('open-gmaps').href = gmapsUrl;

  if (leafletMap) {
    leafletMap.remove();
    leafletMap = null;
  }

  leafletMap = L.map('leaflet-map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(leafletMap);

  const latLngRings = (p.rings || []).map((ring) => ring.map(([lon, lat]) => [lat, lon]));
  let bounds;
  if (latLngRings.length) {
    const polygon = L.polygon(latLngRings, { color: '#2563eb', weight: 3, fillOpacity: 0.15 }).addTo(leafletMap);
    bounds = polygon.getBounds();
  }
  L.marker([p.centroid.lat, p.centroid.lon]).addTo(leafletMap);

  if (bounds) {
    leafletMap.fitBounds(bounds.pad(0.25));
  } else {
    leafletMap.setView([p.centroid.lat, p.centroid.lon], 17);
  }
}

function showError(message) {
  document.getElementById('error-message').textContent = message;
  showScreen('error');
}

async function findNearby() {
  showScreen('loading');

  if (!navigator.geolocation) {
    showError('This browser does not support location lookup.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        const { latitude, longitude } = position.coords;
        const parcels = await findNearestParcels(latitude, longitude);
        if (!parcels.length) {
          showError('No parcels found near your location. Try again from a different spot, or check your internet connection.');
          return;
        }
        currentParcels = parcels;
        renderResults(parcels);
      } catch (e) {
        showError(e.message || 'Something went wrong looking up parcels. Try again.');
      }
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        showError('Location permission was denied. Enable location access for this page in your phone’s browser settings, then try again.');
      } else {
        showError('Could not get your location. Make sure location services are turned on, then try again.');
      }
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

document.getElementById('find-btn').addEventListener('click', findNearby);
document.getElementById('retry-btn').addEventListener('click', findNearby);
document.getElementById('back-btn').addEventListener('click', () => showScreen('results'));
document.getElementById('search-again-btn').addEventListener('click', findNearby);
