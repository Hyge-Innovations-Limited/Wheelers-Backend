/*
 * The bank list on the Withdraw page: each bank's logo (shared/banks/<code>.png, by Paystack bank code)
 * or its initials, the popular banks first and then every bank A–Z under its letter, and search.
 * The app has the same list (Wheelersapp lib/bank-list.ts); keep the two in step.
 */
(function () {
  'use strict';

  /** Bank codes with a logo file in shared/banks/. */
  var LOGOS = {};
  ["00103", "011", "030", "031", "032", "033", "044", "050", "057", "058", "063", "068", "070", "076", "082", "090629", "098", "100", "100022", "100039", "101", "104", "105", "107", "120001", "120002", "120003", "120004", "125", "214", "215", "221", "232", "268", "301", "302", "303", "311", "312", "40165", "413", "50083", "50126", "50162", "50171", "502", "50200", "50204", "50211", "50263", "50304", "50315", "50383", "50439", "50442", "50453", "50457", "50502", "50515", "50549", "50582", "50739", "50743", "50767", "50800", "50823", "50840", "50864", "50871", "50910", "50926", "50931", "51062", "51113", "51204", "51211", "51229", "51244", "51253", "51269", "51293", "51310", "51312", "51314", "51316", "51341", "51355", "559", "565", "566", "602", "801", "812", "865", "90052", "90067", "951113", "FC40163", "MFB50094", "MFB51322"].forEach(function (code) { LOGOS[code] = true; });

  /** Pinned on top, in this order, when the bank is in the list: OPay, Moniepoint, PalmPay, Kuda, GTBank, Access, First Bank, UBA, Zenith, Wema. */
  var POPULAR = ['999992', '50515', '999991', '50211', '058', '044', '011', '033', '057', '035'];

  /** Words left out of a bank's initials. */
  var FILLER = /^(bank|banks|of|the|and|plc|ltd|limited|nigeria|nig|mfb|microfinance|mortgage|psb|services|service|company|co|financial|finance)$/i;

  function logoUrl(code) {
    return LOGOS[code] ? '../shared/banks/' + code + '.png' : null;
  }

  /** "Guaranty Trust Bank" → "GT"; a one-word name → its first two letters. */
  function initials(name) {
    var words = String(name || '').replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
    var kept = words.filter(function (w) { return !FILLER.test(w); });
    var use = kept.length ? kept : words;
    if (use.length === 0) return '?';
    if (use.length === 1) return use[0].slice(0, 2).toUpperCase();
    return (use[0][0] + use[1][0]).toUpperCase();
  }

  function byName(a, b) {
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  }

  /** No search: [{ title: 'Popular', banks }, { title: 'A', banks }, …]; '#' holds names that start with a digit. */
  function sections(banks) {
    var out = [];
    var byCode = {};
    banks.forEach(function (b) { byCode[b.code] = b; });
    var popular = POPULAR.map(function (code) { return byCode[code]; }).filter(Boolean);
    if (popular.length) out.push({ title: 'Popular', banks: popular });
    var letters = {};
    banks.slice().sort(byName).forEach(function (b) {
      var first = b.name.trim().charAt(0).toUpperCase();
      var key = /[A-Z]/.test(first) ? first : '#';
      if (!letters[key]) { letters[key] = []; out.push({ title: key, banks: letters[key] }); }
      letters[key].push(b);
    });
    return out;
  }

  /** Every bank whose name has the search in it: names that start with it first, then a word that does, then the rest. */
  function search(banks, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return banks.slice().sort(byName);
    function rank(b) {
      var n = b.name.toLowerCase();
      if (n.indexOf(q) === 0) return 0;
      if ((' ' + n).indexOf(' ' + q) !== -1) return 1;
      return 2;
    }
    return banks
      .filter(function (b) { return b.name.toLowerCase().indexOf(q) !== -1; })
      .sort(function (a, b) { return rank(a) - rank(b) || byName(a, b); });
  }

  window.WheelersBanks = { logoUrl: logoUrl, initials: initials, sections: sections, search: search, POPULAR: POPULAR };
})();
