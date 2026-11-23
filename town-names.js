/* Old / new town names: "Port Elizabeth" and "Gqeberha" find the same place.
   The list itself is in town-names-data.js. */
window.TownNames = (function () {
  'use strict';
  var key = function (s) { return String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim(); };
  var byName = {};
  (window.TOWN_NAMES || []).forEach(function (t) {
    byName[key(t.now)] = t;
    t.also.forEach(function (a) { byName[key(a)] = t; });
  });

  // Swap an old name for the current one when it is a whole part of the query
  // ("123 Heaven Lane, Port Elizabeth" -> "123 Heaven Lane, Gqeberha"), so street names are never touched.
  function normalize(q) {
    var note = '';
    var parts = q.split(',').map(function (p) {
      var raw = p.trim();
      var t = byName[key(raw)];
      if (t && key(raw) !== key(t.now)) {
        note = raw + ' is now ' + t.now + '.';
        return t.now;
      }
      return raw;
    });
    return { query: parts.filter(Boolean).join(', '), note: note };
  }

  // "Gqeberha" -> "Gqeberha (Port Elizabeth)"
  function label(town) {
    var t = byName[key(town)];
    if (!t) return town;
    return t.now + ' (' + t.also.join(', ') + ')';
  }

  return { normalize: normalize, label: label, lookup: function (name) { return byName[key(name)] || null; } };
})();
