const RADII_METERS = [800, 2000, 5000, 15000, 40000, 100000];
// How many nearby parcels to show. Bill: to change this later, just edit
// the number below and re-upload — nothing else needs to change.
const RESULT_COUNT = 25;

const screens = {
  start: document.getElementById('screen-start'),
  loading: document.getElementById('screen-loading'),
  resultsMap: document.getElementById('screen-results-map'),
  map: document.getElementById('screen-map'),
  error: document.getElementById('screen-error'),
};

let currentParcels = [];
let leafletMap = null;          // single-parcel "full outline" map (screen-map)
let resultsLeafletMap = null;   // multi-parcel overview map (screen-results-map)
let resultsMarkers = [];        // Leaflet layers (polygon + marker) per parcel, for the overview map
let selectedParcelIndex = null; // which parcel is currently shown in the bottom sheet

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

// Convert a parcel's Esri "rings" (arrays of [lon, lat] points) into the
// [lat, lon] point lists Leaflet expects for drawing a polygon.
function parcelToLatLngRings(p) {
  return (p.rings || []).map((ring) => ring.map(([lon, lat]) => [lat, lon]));
}

// A small blue teardrop pin with a number in it (1 = closest parcel).
// Used on the multi-parcel overview map so you can tell at a glance which
// pin is which without opening anything.
function numberedPinIcon(number) {
  return L.divIcon({
    className: '', // avoid Leaflet's default marker box/shadow styling
    html: `<div class="parcel-pin"><span>${number}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

// --- Multi-parcel overview map (screen-results-map) --------------------

function renderResultsMap(parcels) {
  showScreen('resultsMap');
  hideDetailSheet();

  if (resultsLeafletMap) {
    resultsLeafletMap.remove();
    resultsLeafletMap = null;
  }
  resultsMarkers = [];

  // IMPORTANT: the map screen was just made visible (its "hidden" class was
  // just removed) on the line above. If we build the Leaflet map in this
  // same instant, the browser hasn't finished sizing the now-visible
  // container yet, so Leaflet measures it as 0x0. That doesn't just break
  // the tiles — it also throws off where Leaflet thinks each pin actually
  // is on screen, so taps land on the wrong spot (or nothing). Waiting one
  // tick with setTimeout lets the browser finish showing the screen first.
  setTimeout(() => {
    resultsLeafletMap = L.map('leaflet-results-map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(resultsLeafletMap);

    const allLayers = [];

    parcels.forEach((p, i) => {
      const latLngRings = parcelToLatLngRings(p);
      let polygon = null;

      if (latLngRings.length) {
        polygon = L.polygon(latLngRings, { color: '#2563eb', weight: 2, fillOpacity: 0.15 }).addTo(resultsLeafletMap);
        polygon.on('click', () => showDetailSheet(i));
        allLayers.push(polygon);
      }

      const marker = L.marker([p.centroid.lat, p.centroid.lon], { icon: numberedPinIcon(i + 1) }).addTo(resultsLeafletMap);
      marker.on('click', () => showDetailSheet(i));
      allLayers.push(marker);

      resultsMarkers.push({ polygon, marker });
    });

    // Zoom/pan so all 4 parcels are visible at once when the screen opens.
    if (allLayers.length) {
      const group = L.featureGroup(allLayers);
      resultsLeafletMap.fitBounds(group.getBounds().pad(0.2));
    } else if (parcels.length) {
      resultsLeafletMap.setView([parcels[0].centroid.lat, parcels[0].centroid.lon], 15);
    }

    // Re-measure the container now that it's definitely visible and sized,
    // so pin tap targets line up with what you actually see.
    resultsLeafletMap.invalidateSize();

    // Hide the "tap a pin" hint the first time a parcel is opened.
    const hint = document.getElementById('map-hint');
    hint.classList.remove('hidden');
  }, 0);
}

// Phones show/hide their address bar as you scroll, which resizes the
// visible page after the map already loaded. Re-measuring on resize keeps
// pin tap targets accurate instead of drifting out of sync with the tiles.
window.addEventListener('resize', () => {
  if (resultsLeafletMap) resultsLeafletMap.invalidateSize();
  if (leafletMap) leafletMap.invalidateSize();
});

// Fills in and slides up the bottom detail sheet for one parcel.
function showDetailSheet(index) {
  const p = currentParcels[index];
  if (!p) return;
  selectedParcelIndex = index;

  document.getElementById('map-hint').classList.add('hidden');

  document.getElementById('sheet-title').textContent = p.owner || 'Owner not on record';
  document.getElementById('sheet-distance').textContent = formatDistance(p.distanceMeters);

  const rowsWrap = document.getElementById('sheet-rows');
  rowsWrap.innerHTML = '';
  rowsWrap.appendChild(row('Parcel ID (APN)', p.apn || 'Not available'));
  rowsWrap.appendChild(row('Address', p.address || 'Not available'));
  rowsWrap.appendChild(row('Acreage', formatAcres(p.acreage)));
  rowsWrap.appendChild(row('Tax-assessed value', formatMoney(p.taxValue)));
  rowsWrap.appendChild(row('Annual property tax', 'Not publicly available (see note above)'));
  rowsWrap.appendChild(row('Last sale price', formatSalePrice(p.salePrice)));
  rowsWrap.appendChild(row('Last sale date', formatDate(p.saleDate)));
  rowsWrap.appendChild(row('Data source', p.sourceLabel));

  document.getElementById('detail-sheet').classList.add('open');
}

function hideDetailSheet() {
  selectedParcelIndex = null;
  document.getElementById('detail-sheet').classList.remove('open');
}

// --- Single-parcel full outline map (screen-map) ------------------------
// Reached from the bottom sheet's "View Full Parcel Outline" button.

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

  const latLngRings = parcelToLatLngRings(p);
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

  setTimeout(() => leafletMap && leafletMap.invalidateSize(), 0);
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
        renderResultsMap(parcels);
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

// Fill in the "how many parcels" wording from RESULT_COUNT so the two
// places that mention a number always match what the app actually shows.
document.getElementById('start-subtitle').textContent =
  `Find the closest ${RESULT_COUNT} land parcels to your current location, with owner, tax, and sale info from public NC GIS records.`;
document.getElementById('results-map-title').textContent = `Closest ${RESULT_COUNT} Parcels`;

document.getElementById('find-btn').addEventListener('click', findNearby);
document.getElementById('retry-btn').addEventListener('click', findNearby);
document.getElementById('refresh-map-btn').addEventListener('click', findNearby);
document.getElementById('sheet-close-btn').addEventListener('click', hideDetailSheet);
document.getElementById('view-full-btn').addEventListener('click', () => {
  if (selectedParcelIndex !== null) openMap(selectedParcelIndex);
});
document.getElementById('back-btn').addEventListener('click', () => showScreen('resultsMap'));
