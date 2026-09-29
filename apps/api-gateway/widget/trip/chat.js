/* The Wheelers Trip chat page: a WhatsApp rider and their driver, by message
 * and by Live call. No dependencies, no build step.
 *
 * It opens on GET /trip-chat/state, then keeps a socket to /ws with the same
 * link, for messages as they arrive and for calls. While the page is on
 * screen the socket is open, and the server knows not to copy the driver's
 * messages to WhatsApp; when the page is hidden the socket closes and they go
 * to WhatsApp instead. During a call the socket stays open whatever happens.
 *
 * A call is WebRTC between this page and the driver's app, through our own
 * TURN server. The server only rings, answers and passes each side's
 * connection details to the other. */
(function () {
  'use strict';
  var W = window.Wheelers;

  // Read before takeToken() wipes the address: the call to answer on opening.
  var callParam = (/(?:^#|&)call=([^&]+)/.exec(window.location.hash) || [])[1];
  var answerOnOpen = callParam ? decodeURIComponent(callParam) : null;
  var token = W.takeToken();
  if (!token) { W.fatal('This link is not valid.'); return; }

  var state = null;             // the last /trip-chat/state
  var seen = {};                // messageId → true, so nothing shows twice
  var pending = {};             // clientId → the bubble waiting for the server
  var socket = null;
  var socketOpen = false;
  var reconnectTimer = null;
  var reconnectDelay = 1000;
  var pollTimer = null;

  var call = null;              // { id, direction, other, iceServers, pc, stream, queued, timer, answeredAt }

  /* ── small helpers ────────────────────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });
  }
  function mmss(seconds) {
    var m = Math.floor(seconds / 60), s = seconds % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function roleWord(role) { return role === 'DRIVER' ? 'driver' : 'rider'; }

  /* ── the thread ───────────────────────────────────────────────────────── */

  function isMine(message) { return state && state.me && message.senderRole === state.me.role; }

  function bubbleFor(message) {
    if (message.kind === 'call') {
      return el('li', 'line', message.content + ' · ' + clock(message.createdAt));
    }
    var li = el('li', 'msg ' + (isMine(message) ? 'mine' : 'theirs'));
    li.appendChild(document.createTextNode(message.content));
    li.appendChild(el('span', 'time', clock(message.createdAt)));
    return li;
  }

  function scrollDown() {
    var thread = $('thread');
    thread.scrollTop = thread.scrollHeight;
  }

  function addMessage(message) {
    if (!message || !message.messageId || seen[message.messageId]) return;
    seen[message.messageId] = true;
    $('thread').appendChild(bubbleFor(message));
    $('empty').hidden = true;
    scrollDown();
  }

  function drawThread(messages) {
    var thread = $('thread');
    var nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    (messages || []).forEach(function (message) {
      if (seen[message.messageId]) return;
      seen[message.messageId] = true;
      thread.appendChild(bubbleFor(message));
    });
    $('empty').hidden = thread.children.length > 0;
    if (nearBottom) scrollDown();
  }

  function drawHeader() {
    var other = state.other || {};
    $('who-name').textContent = other.name || ('Your ' + roleWord(other.role));
    var meta = [];
    if (other.vehicle) meta.push(other.vehicle);
    if (other.plate) meta.push(other.plate);
    if (state.tripId) meta.push(state.tripId);
    // The code the rider gives the driver to start the trip, until it has been used.
    if (state.tripCode) meta.push('Trip code ' + state.tripCode);
    $('who-meta').textContent = meta.join(' · ');
    var callBtn = $('call-btn');
    callBtn.hidden = !state.callsEnabled;
    callBtn.disabled = !state.open || !!call;
  }

  function drawOpen() {
    var banner = $('banner');
    if (!state.open) {
      banner.textContent = 'This trip has ended, so the chat is closed.';
      banner.hidden = false;
    } else if (state.closesAt) {
      banner.textContent = 'Your trip has ended. This chat stays open for ' + (W.until(state.closesAt) || 'a few minutes') + '.';
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
    $('input').disabled = !state.open;
    $('send').disabled = !state.open || !$('input').value.trim();
  }

  function applyState(next) {
    state = next;
    drawHeader();
    drawOpen();
    drawThread(next.messages);
    if (next.call && !call) offerCall(next.call);
  }

  function refresh() {
    return W.api('GET', '/trip-chat/state').then(function (next) {
      W.showOnly('chat');
      applyState(next);
    }, function (err) {
      if (err.status === 401 || err.status === 403) { W.fatal(err.message); stopEverything(); return; }
      if (!state) W.fatal(err.message);
    });
  }

  /* ── sending ──────────────────────────────────────────────────────────── */

  function sendText(text, reuse) {
    var clientId = W.uuid();
    var bubble = reuse || el('li', 'msg mine pending');
    if (!reuse) {
      bubble.appendChild(document.createTextNode(text));
      $('thread').appendChild(bubble);
      $('empty').hidden = true;
      scrollDown();
    } else {
      bubble.className = 'msg mine pending';
      var stale = bubble.querySelector('.retry');
      if (stale) bubble.removeChild(stale);
    }
    pending[clientId] = { bubble: bubble, text: text };

    if (socketOpen) {
      socket.send(JSON.stringify({ type: 'chat:send', payload: { content: text, clientId: clientId } }));
      // No answer in 10 s: the socket is not really there. Say so, and let them tap to try again.
      setTimeout(function () { if (pending[clientId]) failed(clientId, 'Not sent. Tap to try again.'); }, 10000);
      return;
    }
    W.api('POST', '/trip-chat/send', { content: text }).then(function (res) {
      settled(clientId, res.message);
    }, function (err) {
      failed(clientId, err.message);
    });
  }

  function settled(clientId, message) {
    var item = pending[clientId];
    if (!item) return;
    delete pending[clientId];
    if (message && message.messageId) {
      if (seen[message.messageId]) {
        // It arrived on the socket before the answer did: drop the placeholder.
        if (item.bubble.parentNode) item.bubble.parentNode.removeChild(item.bubble);
        return;
      }
      seen[message.messageId] = true;
      var real = bubbleFor(message);
      item.bubble.parentNode.replaceChild(real, item.bubble);
    }
  }

  function failed(clientId, reason) {
    var item = pending[clientId];
    if (!item) return;
    delete pending[clientId];
    item.bubble.className = 'msg mine failed';
    var retry = el('span', 'retry', reason || 'Not sent. Tap to try again.');
    item.bubble.appendChild(retry);
    item.bubble.onclick = function () {
      item.bubble.onclick = null;
      sendText(item.text, item.bubble);
    };
  }

  $('input').addEventListener('input', function () {
    $('send').disabled = !state || !state.open || !this.value.trim();
    // Grow with the text, up to the CSS max-height.
    this.rows = Math.min(5, Math.max(1, this.value.split('\n').length));
  });
  $('input').addEventListener('keydown', function (event) {
    // Enter sends on a keyboard with Shift for a new line; phones send with the button.
    if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(pointer: fine)').matches) {
      event.preventDefault();
      $('composer').requestSubmit ? $('composer').requestSubmit() : $('send').click();
    }
  });
  $('composer').addEventListener('submit', function (event) {
    event.preventDefault();
    var input = $('input');
    var text = input.value.trim();
    if (!text || !state || !state.open) return;
    input.value = '';
    input.rows = 1;
    $('send').disabled = true;
    sendText(text);
  });

  /* ── the socket ───────────────────────────────────────────────────────── */

  function socketUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + encodeURIComponent(token);
  }

  function connect() {
    if (socket || document.hidden && !call) return;
    clearTimeout(reconnectTimer);
    var ws;
    try { ws = new WebSocket(socketUrl()); } catch (e) { scheduleReconnect(); return; }
    socket = ws;
    ws.onopen = function () {
      socketOpen = true;
      reconnectDelay = 1000;
      stopPolling();
      // Anything missed while the socket was down.
      refresh();
      if (answerOnOpen) send('call:current', {});
    };
    ws.onmessage = function (event) {
      var message;
      try { message = JSON.parse(event.data); } catch (e) { return; }
      handle(message.type, message.payload || {});
    };
    ws.onclose = function () {
      if (socket === ws) { socket = null; socketOpen = false; }
      // Messages still waiting on this socket will never be answered.
      Object.keys(pending).forEach(function (clientId) { failed(clientId, 'Not sent. Tap to try again.'); });
      startPolling();
      if (!document.hidden || call) scheduleReconnect();
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(15000, reconnectDelay * 2);
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    if (socket) { var ws = socket; socket = null; socketOpen = false; ws.onclose = null; ws.close(); }
  }

  function send(type, payload) {
    if (!socketOpen) return false;
    socket.send(JSON.stringify({ type: type, payload: payload || {} }));
    return true;
  }

  /** No socket: ask every few seconds instead, so messages still arrive. */
  function startPolling() {
    if (pollTimer || document.hidden) return;
    pollTimer = setInterval(refresh, 5000);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

  function stopEverything() { stopPolling(); disconnect(); }

  // Off screen, the socket closes, so the driver's messages reach WhatsApp.
  // On screen again: reconnect, and catch up. A call keeps it open throughout.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (!call) { disconnect(); stopPolling(); }
      return;
    }
    connect();
  });

  function handle(type, payload) {
    switch (type) {
      case 'chat:message':
        if (state && payload.rideId === state.rideId) addMessage(payload);
        break;
      case 'chat:closed':
        // The driver ended the trip: show the closed chat at once.
        if (state && payload.rideId === state.rideId) refresh();
        break;
      case 'chat:send:accepted':
        settled(payload.clientId, payload.message);
        break;
      case 'call:incoming':
        if (state && payload.rideId === state.rideId) offerCall(payload);
        break;
      case 'call:current':
        if (payload.call) offerCall(payload.call);
        else if (answerOnOpen) { W.toast('That call has ended. Tap Call to call back.'); answerOnOpen = null; }
        break;
      case 'call:start:accepted':
        if (call && call.direction === 'outgoing' && !call.id) {
          call.id = payload.callId;
          call.iceServers = payload.iceServers || [];
          status(payload.calleeChannel === 'whatsapp' ? 'Ringing on WhatsApp…' : 'Ringing…');
        }
        break;
      case 'call:accepted':
        if (call && call.direction === 'outgoing' && (call.id === payload.callId || !call.id)) {
          call.id = payload.callId;
          startCaller();
        }
        break;
      case 'call:accept:accepted':
        if (call && call.id === payload.callId) { call.iceServers = payload.iceServers || []; startCallee(); }
        break;
      case 'call:signal':
        if (call && call.id === payload.callId) onSignal(payload.signal);
        break;
      case 'call:ended':
        if (call && call.id === payload.callId) {
          var words = { declined: 'Call declined', missed: 'No answer', cancelled: 'Call ended', failed: 'Call could not connect' };
          endCall(words[payload.reason] || 'Call ended', true);
        }
        break;
      case 'error':
        onError(payload);
        break;
    }
  }

  function onError(payload) {
    var message = payload.message || 'Something went wrong.';
    if (payload.requestType === 'chat:send') {
      var ids = Object.keys(pending);
      if (ids.length) failed(ids[0], message);
      if (payload.code === 'CHAT_CLOSED') refresh();
      return;
    }
    if (payload.requestType && payload.requestType.indexOf('call:') === 0) {
      if (payload.requestType === 'call:signal') return;
      if (call && (payload.requestType === 'call:start' || payload.requestType === 'call:accept')) endCall(message, true);
      else W.toast(message);
    }
  }

  /* ── the call ─────────────────────────────────────────────────────────── */

  function status(text) { $('call-status').textContent = text; }

  function showCall(name, incoming) {
    $('call-name').textContent = name;
    $('call-avatar').textContent = (name || '?').charAt(0).toUpperCase();
    $('actions-incoming').hidden = !incoming;
    $('actions-live').hidden = incoming;
    $('call').hidden = false;
    $('call-btn').disabled = true;
  }

  /** A call to answer: from the socket, from state, or from the WhatsApp link. */
  function offerCall(incoming) {
    if (call || !incoming || incoming.state === 'ended') return;
    if (incoming.direction !== 'incoming' || incoming.state !== 'ringing') return;
    call = { id: incoming.callId, direction: 'incoming', other: incoming.other, iceServers: incoming.iceServers || [], queued: [] };
    showCall(incoming.other && incoming.other.name, true);
    status('is calling you…');
    answerOnOpen = null;
    ring(true);
  }

  $('call-btn').addEventListener('click', function () {
    if (call || !state || !state.open) return;
    if (!socketOpen) { W.toast('Connecting… try again in a moment.'); connect(); return; }
    call = { id: null, direction: 'outgoing', other: state.other, iceServers: [], queued: [] };
    showCall(state.other.name, false);
    status('Starting…');
    microphone().then(function () {
      if (!call) return;
      send('call:start', {});
    }, function () {
      endCall('Allow the microphone to make calls.', false);
    });
  });

  $('answer').addEventListener('click', function () {
    if (!call || call.direction !== 'incoming') return;
    ring(false);
    $('actions-incoming').hidden = true;
    $('actions-live').hidden = false;
    status('Connecting…');
    microphone().then(function () {
      if (!call) return;
      if (!send('call:accept', { callId: call.id })) endCall('No connection. Check your network.', false);
    }, function () {
      send('call:decline', { callId: call.id });
      endCall('Allow the microphone to answer calls.', false);
    });
  });

  $('decline').addEventListener('click', function () {
    if (!call) return;
    send('call:decline', { callId: call.id });
    endCall('Call declined', false);
  });

  $('hangup').addEventListener('click', function () {
    if (!call) return;
    if (call.id) send('call:end', { callId: call.id });
    endCall('Call ended', false);
  });

  $('mute').addEventListener('click', function () {
    if (!call || !call.stream) return;
    var track = call.stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.setAttribute('aria-pressed', track.enabled ? 'false' : 'true');
    $('mute-label').textContent = track.enabled ? 'Mute' : 'Muted';
  });

  function microphone() {
    if (call && call.stream) return Promise.resolve(call.stream);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('no microphone'));
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      .then(function (stream) {
        if (!call) { stream.getTracks().forEach(function (t) { t.stop(); }); throw new Error('call gone'); }
        call.stream = stream;
        return stream;
      });
  }

  function makePeer() {
    var pc = new RTCPeerConnection({ iceServers: call.iceServers || [] });
    call.pc = pc;
    call.stream.getTracks().forEach(function (track) { pc.addTrack(track, call.stream); });
    pc.onicecandidate = function (event) {
      if (event.candidate && call) send('call:signal', { callId: call.id, signal: { type: 'candidate', candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate } });
    };
    pc.ontrack = function (event) {
      var audio = $('remote-audio');
      audio.srcObject = event.streams[0];
      var playing = audio.play();
      if (playing && playing.catch) playing.catch(function () { /* the tap that answered allows it */ });
    };
    pc.onconnectionstatechange = function () {
      if (!call || call.pc !== pc) return;
      if (pc.connectionState === 'connected') connected();
      if (pc.connectionState === 'disconnected') status('Reconnecting…');
      if (pc.connectionState === 'failed') {
        send('call:end', { callId: call.id, failed: !call.answeredAt });
        endCall(call.answeredAt ? 'Call dropped' : 'Call could not connect', false);
      }
    };
    return pc;
  }

  /** The caller, once answered: make the offer. */
  function startCaller() {
    status('Connecting…');
    var pc = makePeer();
    pc.createOffer({ offerToReceiveAudio: true }).then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      send('call:signal', { callId: call.id, signal: { type: 'offer', sdp: pc.localDescription.sdp } });
    }).catch(function () {
      send('call:end', { callId: call.id, failed: true });
      endCall('Call could not connect', false);
    });
  }

  /** The person called, once they have answered: wait for the offer. */
  function startCallee() {
    makePeer();
    flushQueued();
  }

  function onSignal(signal) {
    if (!signal || !call) return;
    var pc = call.pc;
    if (!pc) { call.queued.push(signal); return; }
    if (signal.type === 'offer') {
      pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp }).then(function () {
        return pc.createAnswer();
      }).then(function (answer) {
        return pc.setLocalDescription(answer);
      }).then(function () {
        send('call:signal', { callId: call.id, signal: { type: 'answer', sdp: pc.localDescription.sdp } });
        flushQueued();
      }).catch(function () {
        send('call:end', { callId: call.id, failed: true });
        endCall('Call could not connect', false);
      });
    } else if (signal.type === 'answer') {
      pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp }).then(flushQueued).catch(function () { /* the end comes by itself */ });
    } else if (signal.type === 'candidate' || signal.type === 'candidates') {
      var list = signal.type === 'candidates' ? (signal.candidates || []) : [signal.candidate];
      if (!pc.remoteDescription) { list.forEach(function (c) { call.queued.push({ type: 'candidate', candidate: c }); }); return; }
      list.forEach(function (c) { if (c) pc.addIceCandidate(c).catch(function () { /* a stale one */ }); });
    }
  }

  function flushQueued() {
    if (!call || !call.pc) return;
    var queued = call.queued;
    call.queued = [];
    queued.forEach(onSignal);
  }

  function connected() {
    if (!call || call.answeredAt) { status(call ? mmss(Math.floor((Date.now() - call.answeredAt) / 1000)) : ''); return; }
    call.answeredAt = Date.now();
    ring(false);
    status('0:00');
    call.timer = setInterval(function () {
      if (call) status(mmss(Math.floor((Date.now() - call.answeredAt) / 1000)));
    }, 1000);
  }

  /** Tidy up the call, whoever ended it, and say how it ended for a moment. */
  function endCall(words, fromServer) {
    if (!call) return;
    var ending = call;
    call = null;
    ring(false);
    clearInterval(ending.timer);
    if (ending.pc) { try { ending.pc.close(); } catch (e) { /* closed */ } }
    if (ending.stream) ending.stream.getTracks().forEach(function (t) { t.stop(); });
    $('remote-audio').srcObject = null;
    $('mute').setAttribute('aria-pressed', 'false');
    $('mute-label').textContent = 'Mute';
    status(words);
    $('actions-incoming').hidden = true;
    $('actions-live').hidden = true;
    setTimeout(function () {
      if (!call) {
        $('call').hidden = true;
        if (state) drawHeader();
      }
    }, fromServer ? 1600 : 900);
    if (document.hidden) disconnect();
  }

  /* ── a ring you can hear, made on the page (no sound files to load) ───── */

  var ringer = null;
  function ring(on) {
    if (!on) {
      if (ringer) { clearInterval(ringer.timer); try { ringer.ctx.close(); } catch (e) { /* closed */ } ringer = null; }
      return;
    }
    if (ringer) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    var ctx;
    try { ctx = new Ctx(); } catch (e) { return; }
    function burst() {
      if (ctx.state === 'suspended') ctx.resume().catch(function () { /* needs a tap first */ });
      [440, 480].forEach(function (hz) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.frequency.value = hz;
        gain.gain.value = 0.08;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 1.2);
      });
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    }
    burst();
    ringer = { ctx: ctx, timer: setInterval(burst, 3000) };
  }

  /* ── go ───────────────────────────────────────────────────────────────── */

  window.addEventListener('pagehide', function () {
    if (call && call.id) send('call:end', { callId: call.id });
  });

  refresh().then(function () { connect(); });
})();
