/*
 * Which device this person is on, for their admin profile (collected only: the page does nothing with it).
 * Once per visit, two seconds after the page opens, with the page's own link: the screen, RAM and CPU cores,
 * the network type and data saver, language and time zone, whether it was opened from WhatsApp, and on
 * Chrome-based browsers the phone model and exact system version (Chrome's device hints).
 * Never the phone's name, an advertising id or a fingerprint. A failure is silent.
 */
(function () {
  'use strict';
  var W = window.Wheelers;
  if (!W || !W.api || !window.fetch) return;

  function base() {
    var n = navigator;
    var c = n.connection || {};
    var zone = null;
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { zone = null; }
    return {
      screenW: window.screen ? window.screen.width : null,
      screenH: window.screen ? window.screen.height : null,
      dpr: window.devicePixelRatio || null,
      ramGb: typeof n.deviceMemory === 'number' ? n.deviceMemory : null,
      cores: typeof n.hardwareConcurrency === 'number' ? n.hardwareConcurrency : null,
      network: typeof c.effectiveType === 'string' ? c.effectiveType : null,
      saveData: typeof c.saveData === 'boolean' ? c.saveData : null,
      fromWhatsapp: /com\.whatsapp/.test(document.referrer || '') ? true : null,
      language: n.language || null,
      timeZone: zone
    };
  }

  function send(extra) {
    var body = base();
    Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
    W.api('POST', '/device/web', body).catch(function () { /* silent */ });
  }

  setTimeout(function () {
    var hints = navigator.userAgentData;
    if (hints && typeof hints.getHighEntropyValues === 'function') {
      hints.getHighEntropyValues(['model', 'platformVersion'])
        .then(function (h) { send({ model: h.model || null, platformVersion: h.platformVersion || null, platform: hints.platform || null, mobile: hints.mobile === true }); })
        .catch(function () { send({}); });
    } else {
      send({});
    }
  }, 2000);
})();
