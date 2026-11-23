/* Nearest tyre suppliers: map + 3 nearest by driving distance.
   Suppliers load from suppliers.csv (the Sheet's columns) and reload every 3 minutes. */
(function () {
  'use strict';

  var SHEET_URL = 'suppliers.csv';
  var REFRESH_MS = 3 * 60 * 1000;
  var PREFILTER = 10;          // straight-line shortlist sent to the routing table
  var SHOW = 3;
  var OSRM = 'https://router.project-osrm.org';
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  var RANK_COLORS = ['#e8590c', '#1971c2', '#6741d9'];
  var SA_BOUNDS = [[-34.9, 16.4], [-22.1, 32.9]];

  var map = L.map('map', { zoomControl: true, tap: true }).fitBounds(SA_BOUNDS);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  var supLayer = L.layerGroup().addTo(map);
  var nearLayer = L.layerGroup().addTo(map);
  var routeLayer = L.layerGroup().addTo(map);
  var suppliers = [];
  var bdMarker = null;
  var lastOrigin = null;
  var busy = false;

  var $ = function (id) { return document.getElementById(id); };
  var form = $('form'), input = $('q'), goBtn = $('go'), statusEl = $('status');
  var list = $('list'), empty = $('empty'), countEl = $('count'), refreshedEl = $('refreshed');

  /* ---------- the Sheet ---------- */
  function parseCSV(text) {
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.join('').trim(); });
  }

  function loadSheet() {
    return fetch(SHEET_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var rows = parseCSV(text);
        var head = rows.shift().map(function (h) { return h.trim().toLowerCase(); });
        var col = function (name) { return head.indexOf(name); };
        var iName = col('name'), iNum = col('whatsapp number'), iTown = col('town'),
            iGps = col('gps coordinates'), iSvc = col('services'), iHours = col('hours');
        suppliers = rows.map(function (r, n) {
          var m = String(r[iGps] || '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
          if (!m) return null;
          return { id: n, name: r[iName], num: (r[iNum] || '').trim(), town: r[iTown] || '',
                   lat: +m[1], lng: +m[2], services: r[iSvc] || '', hours: r[iHours] || '' };
        }).filter(Boolean);
        drawSuppliers();
        countEl.textContent = suppliers.length + ' suppliers';
        var t = new Date();
        refreshedEl.textContent = 'List updated ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      })
      .catch(function () { countEl.textContent = 'Could not load the supplier list'; });
  }

  function popupHtml(s) {
    var num = s.num ? '<a href="https://wa.me/' + s.num.replace(/\D/g, '') + '" target="_blank" rel="noopener">' + esc(s.num) + '</a>' : '<span>no number listed</span>';
    return '<div class="pop"><div class="pn">' + esc(s.name) + '</div>' +
      '<div class="pt">' + esc(TownNames.label(s.town)) + '</div>' +
      '<div class="pr"><span>Number:</span> ' + num + '</div>' +
      '<div class="pr"><span>Services:</span> ' + esc(s.services || 'not listed') + '</div>' +
      (s.hours ? '<div class="pr"><span>Hours:</span> ' + esc(s.hours) + '</div>' : '') + '</div>';
  }

  function drawSuppliers() {
    supLayer.clearLayers();
    var icon = L.divIcon({ className: '', html: '<div class="sup-pin"></div>', iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6] });
    suppliers.forEach(function (s) {
      s.marker = L.marker([s.lat, s.lng], { icon: icon, title: s.name }).bindPopup(popupHtml(s)).addTo(supLayer);
    });
  }

  /* ---------- reading the location box ---------- */
  function inSA(lat, lng) { return lat > -35.5 && lat < -21.5 && lng > 15.5 && lng < 33.5; }

  function parseCoords(raw) {
    var s = raw.trim();
    try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
    var pats = [
      /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,                                   // place links
      /[?&](?:q|query|ll|sll|destination|daddr|center|saddr)=(?:loc:)?(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/i,
      /@(-?\d+\.\d+),(-?\d+\.\d+)/,                                        // map view links
      /^\s*(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)\s*$/                 // bare "lat, lng"
    ];
    for (var i = 0; i < pats.length; i++) {
      var m = s.match(pats[i]);
      if (m) {
        var a = +m[1], b = +m[2];
        if (inSA(a, b)) return { lat: a, lng: b };
        if (inSA(b, a)) return { lat: b, lng: a, note: 'Read as latitude ' + b + ', longitude ' + a + '.' };
        if (inSA(-a, b)) return { lat: -a, lng: b, note: 'South Africa is south of the equator, so this was read as ' + (-a) + '.' };
        return { outside: true };
      }
    }
    return null;
  }

  function isShortLink(s) { return /(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i.test(s); }

  function geocode(text) {
    // Try the full address, then drop leading parts ("123 Heaven Lane, Johannesburg" -> "Johannesburg")
    var parts = text.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    var tries = [];
    for (var i = 0; i < parts.length; i++) {
      var t = parts.slice(i).join(', ');
      if (!/^(south africa|za|rsa)$/i.test(t)) tries.push(t);
    }
    if (!tries.length) tries.push(text);
    tries = tries.slice(0, 3);
    var step = function (k) {
      if (k >= tries.length) return Promise.resolve(null);
      var url = NOMINATIM + '?format=jsonv2&limit=1&countrycodes=za&accept-language=en&q=' + encodeURIComponent(tries[k]);
      var wait = k === 0 ? Promise.resolve() : new Promise(function (r) { setTimeout(r, 1100); });
      return wait.then(function () { return fetch(url, { headers: { 'Accept': 'application/json' } }); })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res && res.length) return { lat: +res[0].lat, lng: +res[0].lon, label: res[0].display_name, partial: k > 0, used: tries[k] };
          return step(k + 1);
        });
    };
    return step(0);
  }

  /* ---------- nearest by driving distance ---------- */
  function haversine(a, b) {
    var R = 6371, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function nearest(origin) {
    var short = suppliers.map(function (s) { return { s: s, crow: haversine(origin, s) }; })
      .sort(function (a, b) { return a.crow - b.crow; }).slice(0, PREFILTER);
    var coords = [origin].concat(short.map(function (x) { return x.s; }))
      .map(function (p) { return p.lng.toFixed(6) + ',' + p.lat.toFixed(6); }).join(';');
    return fetch(OSRM + '/table/v1/driving/' + coords + '?sources=0&annotations=duration,distance')
      .then(function (r) { return r.json(); })
      .then(function (t) {
        if (t.code !== 'Ok') throw new Error('routing');
        short.forEach(function (x, i) { x.km = t.distances[0][i + 1] / 1000; x.sec = t.durations[0][i + 1]; });
        return short.filter(function (x) { return x.km != null && !isNaN(x.km); })
          .sort(function (a, b) { return a.km - b.km; }).slice(0, SHOW);
      });
  }

  function drawRoute(origin, x, i) {
    var url = OSRM + '/route/v1/driving/' + origin.lng + ',' + origin.lat + ';' + x.s.lng + ',' + x.s.lat + '?overview=full&geometries=geojson';
    return fetch(url).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.routes || !res.routes[0]) return null;
      var line = res.routes[0].geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
      return L.polyline(line, { color: RANK_COLORS[i], weight: i === 0 ? 6 : 4, opacity: i === 0 ? 0.9 : 0.75 }).addTo(routeLayer);
    }).catch(function () { return null; });
  }

  /* ---------- running a lookup ---------- */
  function setStatus(html, kind) {
    statusEl.hidden = !html;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
    statusEl.innerHTML = html || '';
  }

  function placeBreakdown(origin) {
    var icon = L.divIcon({
      className: 'bd-pin', iconSize: [30, 40], iconAnchor: [15, 39],
      html: '<svg width="30" height="40" viewBox="0 0 30 40"><path d="M15 39C15 39 28 23.5 28 14.5A13 13 0 0 0 2 14.5C2 23.5 15 39 15 39Z" fill="#c92a2a" stroke="#fff" stroke-width="2"/><circle cx="15" cy="14.5" r="5" fill="#fff"/></svg>'
    });
    if (bdMarker) bdMarker.setLatLng([origin.lat, origin.lng]);
    else {
      bdMarker = L.marker([origin.lat, origin.lng], { icon: icon, draggable: true, zIndexOffset: 1000, title: 'Breakdown' }).addTo(map);
      bdMarker.on('dragend', function () {
        var p = bdMarker.getLatLng();
        run({ lat: p.lat, lng: p.lng, label: 'moved on the map', pin: true });
      });
    }
  }

  function run(origin) {
    if (!suppliers.length) return;
    lastOrigin = origin;
    placeBreakdown(origin);
    nearLayer.clearLayers(); routeLayer.clearLayers();
    list.innerHTML = '';
    empty.hidden = true;
    var note = origin.note ? ' ' + esc(origin.note) : '';
    var where = origin.pin ? 'Breakdown pin ' + esc(origin.label) + '.' : 'Breakdown at <b>' + esc(origin.label) + '</b>.';
    setStatus(where + note + ' Finding the closest by road…', origin.warn ? 'warn' : '');
    return nearest(origin).then(function (top) {
      if (!top.length) { setStatus('No supplier can be reached by road from that spot.', 'err'); return; }
      setStatus(where + note, origin.warn ? 'warn' : '');
      var bounds = L.latLngBounds([[origin.lat, origin.lng]]);
      top.forEach(function (x, i) {
        bounds.extend([x.s.lat, x.s.lng]);
        var icon = L.divIcon({ className: '', html: '<div class="near-pin" style="background:' + RANK_COLORS[i] + '">' + (i + 1) + '</div>', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] });
        x.pin = L.marker([x.s.lat, x.s.lng], { icon: icon, zIndexOffset: 900 - i }).bindPopup(popupHtml(x.s)).addTo(nearLayer);
        list.appendChild(card(x, i));
      });
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
      return Promise.all(top.map(function (x, i) { return drawRoute(origin, x, i); })).then(function (lines) {
        lines.forEach(function (l) { if (l) bounds.extend(l.getBounds()); });
        map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
        routeLayer.eachLayer(function (l) { l.bringToBack(); });
      });
    }).catch(function () {
      setStatus('The drive-time service did not answer. Try again in a moment.', 'err');
    });
  }

  function card(x, i) {
    var s = x.s;
    var li = document.createElement('li');
    li.className = 'card';
    var mins = Math.round(x.sec / 60);
    var time = mins >= 60 ? Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min' : mins + ' min';
    var km = x.km < 10 ? x.km.toFixed(1) : Math.round(x.km);
    li.innerHTML =
      '<div class="rank" style="background:' + RANK_COLORS[i] + '">' + (i + 1) + '</div>' +
      '<div><div class="name">' + esc(s.name) + '</div><div class="town">' + esc(TownNames.label(s.town)) + '</div></div>' +
      '<div class="dist"><div class="km">' + km + ' km</div><div class="min">' + time + '</div></div>' +
      '<div class="meta">' + esc(s.services || 'Services not listed') + (s.hours ? ' · ' + esc(s.hours) : '') + '</div>' +
      '<div class="acts">' +
        (s.num ? '<a class="msg" href="https://wa.me/' + s.num.replace(/\D/g, '') + '" target="_blank" rel="noopener">Message</a>' : '') +
        '<button type="button" class="show">Show on map</button>' +
      '</div>';
    li.addEventListener('click', function (e) {
      if (e.target.closest('a')) return;
      map.setView([s.lat, s.lng], Math.max(map.getZoom(), 13));
      x.pin.openPopup();
      if (window.innerWidth <= 860) document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return li;
  }

  function submit(raw) {
    raw = (raw || '').trim();
    if (!raw || busy) return;
    if (isShortLink(raw)) {
      setStatus('Short Google Maps links can only be opened by Google, not from this page. Open the link, then paste the coordinates or the long link from the address bar.', 'warn');
      return;
    }
    var c = parseCoords(raw);
    if (c && c.outside) { setStatus('Those coordinates are outside South Africa.', 'err'); return; }
    if (c) { run({ lat: c.lat, lng: c.lng, label: c.lat.toFixed(5) + ', ' + c.lng.toFixed(5), note: c.note, warn: !!c.note }); return; }
    var norm = TownNames.normalize(raw);
    busy = true; goBtn.disabled = true;
    list.innerHTML = ''; nearLayer.clearLayers(); routeLayer.clearLayers();
    setStatus('Looking up <b>' + esc(norm.query) + '</b>…' + (norm.note ? ' ' + esc(norm.note) : ''));
    geocode(norm.query).then(function (g) {
      if (!g) { setStatus('Could not find that place in South Africa. Try the town name, or tap the map.', 'err'); return; }
      var label = g.label.split(', ').filter(function (p) { return !/Municipality|Ward \d|^\d{4}$|^South Africa$/.test(p); }).slice(0, 3).join(', ');
      var note = norm.note || '';
      if (g.partial) note += (note ? ' ' : '') + 'The street was not found, so the pin is on ' + g.used.replace(/, *(South Africa|ZA|RSA)$/i, '') + '.';
      return run({ lat: g.lat, lng: g.lng, label: label, note: note, warn: g.partial });
    }).catch(function () {
      setStatus('The address search did not answer. Try again, or tap the map.', 'err');
    }).then(function () { busy = false; goBtn.disabled = false; });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); input.blur(); submit(input.value); });
  document.getElementById('chips').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-q]');
    if (!b) return;
    input.value = b.getAttribute('data-q');
    submit(input.value);
  });
  map.on('click', function (e) {
    input.value = '';
    run({ lat: e.latlng.lat, lng: e.latlng.lng, label: 'dropped on the map', pin: true });
  });

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  loadSheet();
  setInterval(function () { loadSheet().then(function () { if (lastOrigin) { /* keep current results; new rows count from the next lookup */ } }); }, REFRESH_MS);
})();
