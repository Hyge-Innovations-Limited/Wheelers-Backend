/* Shared by the Wheelers wallet pages. No dependencies, no build step. */
(function () {
  'use strict';

  var TOKEN_KEY = 'wheelers.wallet.page.token';

  /**
   * The link token arrives in the URL #fragment — the one part of a URL a
   * browser never sends to a server or a referrer. Read it, keep it for this
   * tab only (so a refresh still works), then wipe it from the address bar so
   * it cannot be copied out of a screenshot or the history.
   */
  function takeToken() {
    var match = /(?:^#|&)t=([^&]+)/.exec(window.location.hash);
    if (match) {
      try { sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1])); } catch (e) { /* private mode */ }
      window.__wheelersToken = decodeURIComponent(match[1]);
      history.replaceState(null, '', window.location.pathname);
    }
    if (!window.__wheelersToken) {
      try { window.__wheelersToken = sessionStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    }
    return window.__wheelersToken || null;
  }

  function ApiError(message, status, body) {
    this.message = message;
    this.status = status;
    this.code = (body && body.code) || null;
    this.body = body || {};
  }

  function api(method, path, body, extraHeaders) {
    var headers = { Authorization: 'Bearer ' + (window.__wheelersToken || '') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    Object.keys(extraHeaders || {}).forEach(function (k) { headers[k] = extraHeaders[k]; });
    return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          if (!res.ok) throw new ApiError(json.error || 'Something went wrong. Please try again.', res.status, json);
          return json;
        });
      }, function () {
        throw new ApiError('No internet connection. Check your network and try again.', 0, { code: 'OFFLINE' });
      });
  }

  function naira(value) {
    var n = Number(value) || 0;
    var hasKobo = Math.round(n * 100) % 100 !== 0;
    return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: hasKobo ? 2 : 0, maximumFractionDigits: 2 });
  }

  /** "12,500" ⇄ 12500 while the user types. */
  function parseAmount(text) {
    var n = Number(String(text).replace(/[^\d.]/g, ''));
    return isFinite(n) ? n : 0;
  }
  function formatAmountInput(input) {
    var n = parseAmount(input.value);
    input.value = n > 0 ? Math.floor(n).toLocaleString('en-NG') : '';
    return n;
  }

  function $(id) { return document.getElementById(id); }
  function show(el, visible) { if (el) el.hidden = !visible; }

  function showOnly(viewId) {
    var views = document.querySelectorAll('[data-view]');
    for (var i = 0; i < views.length; i++) views[i].hidden = views[i].getAttribute('data-view') !== viewId;
    window.scrollTo(0, 0);
  }

  var toastTimer;
  function toast(message) {
    var el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'offscreen';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function until(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return '';
    var minutes = Math.ceil(ms / 60000);
    if (minutes < 90) return minutes + ' minute' + (minutes === 1 ? '' : 's');
    return Math.ceil(minutes / 60) + ' hours';
  }

  /** A link problem is final: show it instead of the page. */
  function fatal(message) {
    $('fatal-message').textContent = message;
    showOnly('fatal');
  }

  window.Wheelers = {
    takeToken: takeToken, api: api, naira: naira, parseAmount: parseAmount, formatAmountInput: formatAmountInput,
    $: $, show: show, showOnly: showOnly, toast: toast, copy: copy, uuid: uuid, until: until, fatal: fatal,
  };
})();
