/*
 * 2PlayerRB — Multiplayer module for Retro Bowl (Firebase version)
 * Uses Firebase Realtime Database for room management, turn coordination,
 * score tracking, and canvas frame streaming.
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────
  var FRAME_INTERVAL_MS = 200; // 5 fps for Firebase bandwidth
  var FRAME_QUALITY = 0.3;
  var FRAME_WIDTH = 240; // downsample for bandwidth
  var FRAME_HEIGHT = 135;

  // ── Firebase refs (set after init) ──────────────────────
  var db = null;
  var roomRef = null;

  // ── State ───────────────────────────────────────────────
  var MP = window.MP = {
    roomCode: null,
    playerIndex: -1,
    isMyTurn: false,
    gamePhase: 'idle', // idle | lobby | waiting | playing | spectating | finished
    myTotalScore: 0,
    opponentTotalScore: 0,
    opponentName: '',
    quarter: 1,
    driveNum: 0,

    // Drive detection
    lastCommStage: -1,
    lastPossession: -1,
    lastQuarter: -1,
    lastRoom: -1,
    driveStartScore: 0,
    driveCycleState: 'idle',
    matchObjPolling: null,

    // Frame streaming
    frameInterval: null,
    spectateCanvas: null,
    spectateCtx: null,
    offscreenCanvas: null,
    offscreenCtx: null,

    // Firebase listeners
    listeners: [],

    pingInterval: null
  };

  // ── Utility ─────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  // ── Firebase Helpers ────────────────────────────────────
  function initFirebase() {
    if (db) return true;
    if (!window.firebase || !firebase.database) {
      console.error('Firebase not loaded');
      return false;
    }
    db = firebase.database();
    return true;
  }

  function generateCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var code = '';
    for (var i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function cleanupListeners() {
    MP.listeners.forEach(function (l) {
      l.ref.off(l.event, l.fn);
    });
    MP.listeners = [];
  }

  function listen(ref, event, fn) {
    ref.on(event, fn);
    MP.listeners.push({ ref: ref, event: event, fn: fn });
  }

  // ── Room Management ─────────────────────────────────────
  function createRoom(callback) {
    var code = generateCode();
    var ref = db.ref('rooms/' + code);
    ref.once('value', function (snap) {
      if (snap.exists()) {
        // Code collision, try again
        createRoom(callback);
        return;
      }
      ref.set({
        state: 'waiting',
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        players: {
          0: { ready: false, teamName: 'Player 1' }
        },
        currentTurn: -1,
        quarter: 1,
        driveCount: 0,
        scores: { 0: 0, 1: 0 }
      }).then(function () {
        MP.roomCode = code;
        MP.playerIndex = 0;
        roomRef = ref;
        // Set up disconnect cleanup
        ref.child('players/0').onDisconnect().remove();
        callback(code);
      });
    });
  }

  function joinRoom(code, callback, errorCallback) {
    var ref = db.ref('rooms/' + code);
    ref.once('value', function (snap) {
      if (!snap.exists()) {
        errorCallback('Room not found');
        return;
      }
      var room = snap.val();
      if (room.players && room.players[1]) {
        errorCallback('Room is full');
        return;
      }
      if (room.state !== 'waiting') {
        errorCallback('Game already started');
        return;
      }
      ref.child('players/1').set({ ready: false, teamName: 'Player 2' }).then(function () {
        MP.roomCode = code;
        MP.playerIndex = 1;
        roomRef = ref;
        ref.child('players/1').onDisconnect().remove();
        callback();
      });
    });
  }

  function listenForOpponent() {
    listen(roomRef.child('players'), 'value', function (snap) {
      var players = snap.val();
      if (!players) return;
      if (players[0] && players[1]) {
        // Both players present
        if (MP.gamePhase === 'waiting') {
          showReadyScreen();
        }
        // Check if both ready
        if (players[0].ready && players[1].ready && MP.gamePhase !== 'playing' && MP.gamePhase !== 'spectating' && MP.gamePhase !== 'finished') {
          startGame();
        }
      }
      // Track opponent name
      var oppIdx = MP.playerIndex === 0 ? 1 : 0;
      if (players[oppIdx]) {
        MP.opponentName = players[oppIdx].teamName || ('Player ' + (oppIdx + 1));
      }
      // Opponent disconnected
      if (MP.gamePhase !== 'idle' && MP.gamePhase !== 'lobby' && MP.gamePhase !== 'waiting') {
        if (!players[oppIdx]) {
          showOverlay('<h2>OPPONENT DISCONNECTED</h2><p>You win by forfeit!</p>' +
            '<button class="mp-btn" onclick="MP.backToMenu()">BACK</button>');
          MP.gamePhase = 'finished';
          stopFrameCapture();
          stopDriveMonitor();
          unblockInput();
        }
      }
    });
  }

  function startGame() {
    roomRef.once('value', function (snap) {
      var room = snap.val();
      if (room.state === 'playing') return; // already started

      // Player 0 does the coin toss
      if (MP.playerIndex === 0) {
        var firstPlayer = Math.random() < 0.5 ? 0 : 1;
        roomRef.update({
          state: 'playing',
          currentTurn: firstPlayer,
          quarter: 1,
          driveCount: 0,
          scores: { 0: 0, 1: 0 }
        });
      }
    });

    // Listen for game state changes
    listen(roomRef, 'value', function (snap) {
      var room = snap.val();
      if (!room || room.state !== 'playing') return;

      MP.quarter = room.quarter || 1;
      MP.driveNum = room.driveCount || 0;
      MP.myTotalScore = (room.scores && room.scores[MP.playerIndex]) || 0;
      MP.opponentTotalScore = (room.scores && room.scores[MP.playerIndex === 0 ? 1 : 0]) || 0;

      if (room.currentTurn === MP.playerIndex) {
        if (MP.gamePhase !== 'playing') {
          MP.isMyTurn = true;
          MP.gamePhase = 'playing';
          onMyTurnStart();
        }
      } else if (room.currentTurn >= 0) {
        if (MP.gamePhase !== 'spectating') {
          MP.isMyTurn = false;
          MP.gamePhase = 'spectating';
          onSpectateStart();
        }
      }
    });

    // Listen for game over
    listen(roomRef.child('state'), 'value', function (snap) {
      if (snap.val() === 'finished') {
        roomRef.once('value', function (rSnap) {
          var room = rSnap.val();
          MP.gamePhase = 'finished';
          MP.myTotalScore = (room.scores && room.scores[MP.playerIndex]) || 0;
          MP.opponentTotalScore = (room.scores && room.scores[MP.playerIndex === 0 ? 1 : 0]) || 0;
          stopFrameCapture();
          stopDriveMonitor();
          unblockInput();
          var winner = MP.myTotalScore > MP.opponentTotalScore ? MP.playerIndex :
                       MP.opponentTotalScore > MP.myTotalScore ? (MP.playerIndex === 0 ? 1 : 0) : -1;
          showGameOver(winner, MP.playerIndex);
        });
      }
    });
  }

  // ── Turn Management ─────────────────────────────────────
  function onMyTurnStart() {
    hideSpectateView();
    unblockInput();
    startFrameCapture();
    startDriveMonitor();
    updateScorebar();
    showTurnBanner('YOUR TURN — PLAY YOUR DRIVE!');
  }

  function onSpectateStart() {
    stopFrameCapture();
    stopDriveMonitor();
    blockInput();
    showSpectateView();
    updateScorebar();
    listenForFrames();
  }

  // ── Drive End Detection ─────────────────────────────────
  function startDriveMonitor() {
    MP.driveCycleState = 'idle';
    MP.lastCommStage = -1;
    MP.lastPossession = -1;
    MP.lastQuarter = -1;
    MP.lastRoom = -1;
    MP.driveStartScore = getCurrentHumanScore();

    MP.matchObjPolling = setInterval(function () {
      try {
        var room = _ft._gt();

        if (room === 22 && MP.lastRoom === 14) {
          clearInterval(MP.matchObjPolling);
          var finalScore = getCurrentHumanScore();
          var points = finalScore - MP.driveStartScore;
          endDrive(points, MP.quarter, true);
          return;
        }
        MP.lastRoom = room;
        if (room !== 14) return;

        var m = _6E2._Ue2(71);
        if (!m) return;

        var commStage = m._Vy;
        var possession = m._UD;
        var quarter = m._Wy;
        var humanTeam = m._0z;
        var scores = m._Sb1;

        if (MP.driveCycleState === 'idle') {
          if (possession === humanTeam) {
            MP.driveCycleState = 'human_offense';
            MP.driveStartScore = scores ? scores[humanTeam] : 0;
          }
        } else if (MP.driveCycleState === 'human_offense') {
          if (possession !== humanTeam && MP.lastPossession === humanTeam) {
            MP.driveCycleState = 'ai_offense';
          }
          if (commStage === 17 && MP.lastCommStage !== 17) {
            MP.driveCycleState = 'ai_offense';
          }
        } else if (MP.driveCycleState === 'ai_offense') {
          if (possession === humanTeam && MP.lastPossession !== humanTeam) {
            var currentScore = scores ? scores[humanTeam] : 0;
            var pointsThisDrive = currentScore - MP.driveStartScore;
            endDrive(pointsThisDrive, quarter, false);
            return;
          }
          if (commStage === 17 && MP.lastCommStage !== 17 && quarter !== MP.lastQuarter) {
            var currentScore2 = scores ? scores[humanTeam] : 0;
            var pointsThisDrive2 = currentScore2 - MP.driveStartScore;
            endDrive(pointsThisDrive2, quarter, false);
            return;
          }
        }

        MP.lastCommStage = commStage;
        MP.lastPossession = possession;
        MP.lastQuarter = quarter;
      } catch (e) {}
    }, 200);
  }

  function stopDriveMonitor() {
    if (MP.matchObjPolling) {
      clearInterval(MP.matchObjPolling);
      MP.matchObjPolling = null;
    }
  }

  function endDrive(pointsThisDrive, quarter, gameEnded) {
    stopDriveMonitor();
    stopFrameCapture();
    blockInput();

    if (!roomRef) return;

    roomRef.once('value', function (snap) {
      var room = snap.val();
      if (!room) return;

      var newScores = room.scores || { 0: 0, 1: 0 };
      newScores[MP.playerIndex] = (newScores[MP.playerIndex] || 0) + pointsThisDrive;
      var newDriveCount = (room.driveCount || 0) + 1;
      var newQuarter = quarter > (room.quarter || 1) ? quarter : (room.quarter || 1);

      var totalDrivesPerPlayer = 8;
      if (gameEnded || newDriveCount >= totalDrivesPerPlayer * 2) {
        roomRef.update({
          state: 'finished',
          scores: newScores,
          driveCount: newDriveCount,
          quarter: newQuarter
        });
        return;
      }

      var nextTurn = MP.playerIndex === 0 ? 1 : 0;
      roomRef.update({
        currentTurn: nextTurn,
        scores: newScores,
        driveCount: newDriveCount,
        quarter: newQuarter,
        frame: null // clear frame data
      });
    });

    showTurnBanner('DRIVE COMPLETE — WAITING FOR OPPONENT...');
  }

  function getCurrentHumanScore() {
    try {
      var m = _6E2._Ue2(71);
      if (m && m._Sb1 && m._0z !== undefined) {
        return m._Sb1[m._0z] || 0;
      }
    } catch (e) {}
    return 0;
  }

  // ── Canvas Frame Streaming ──────────────────────────────
  function startFrameCapture() {
    stopFrameCapture();
    var canvas = document.getElementById('canvas');
    if (!canvas || !roomRef) return;

    // Create offscreen canvas for downsampling
    if (!MP.offscreenCanvas) {
      MP.offscreenCanvas = document.createElement('canvas');
      MP.offscreenCanvas.width = FRAME_WIDTH;
      MP.offscreenCanvas.height = FRAME_HEIGHT;
      MP.offscreenCtx = MP.offscreenCanvas.getContext('2d');
    }

    MP.frameInterval = setInterval(function () {
      if (!MP.isMyTurn || !roomRef) return;
      try {
        MP.offscreenCtx.drawImage(canvas, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
        var dataUrl = MP.offscreenCanvas.toDataURL('image/jpeg', FRAME_QUALITY);
        // Strip the data:image/jpeg;base64, prefix to save bandwidth
        var b64 = dataUrl.split(',')[1];
        roomRef.child('frame').set(b64);
      } catch (e) {}
    }, FRAME_INTERVAL_MS);
  }

  function stopFrameCapture() {
    if (MP.frameInterval) {
      clearInterval(MP.frameInterval);
      MP.frameInterval = null;
    }
  }

  function listenForFrames() {
    listen(roomRef.child('frame'), 'value', function (snap) {
      var b64 = snap.val();
      if (!b64 || MP.gamePhase !== 'spectating') return;
      var img = new Image();
      img.onload = function () {
        if (MP.spectateCtx) {
          MP.spectateCtx.drawImage(img, 0, 0, MP.spectateCanvas.width, MP.spectateCanvas.height);
        }
      };
      img.src = 'data:image/jpeg;base64,' + b64;
    });
  }

  // ── Input Blocking ──────────────────────────────────────
  var inputBlocker = null;

  function blockInput() {
    if (!inputBlocker) {
      inputBlocker = document.createElement('div');
      inputBlocker.id = 'mp-input-blocker';
      inputBlocker.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:500;cursor:not-allowed;';
      document.body.appendChild(inputBlocker);
    }
    inputBlocker.style.display = 'block';
  }

  function unblockInput() {
    if (inputBlocker) {
      inputBlocker.style.display = 'none';
    }
  }

  // ── Keyboard Guard ────────────────────────────────────────
  // The GameMaker engine calls _ID2() repeatedly in its game loop, which
  // re-registers window.onkeydown/onkeyup. Those handlers call
  // preventDefault() on every keystroke, blocking input fields.
  //
  // Fix: use Object.defineProperty to intercept writes to onkeydown/onkeyup.
  // When overlay is visible, we store the handler but return a no-op wrapper
  // that skips preventDefault when the event target is inside our overlay.
  var overlayVisible = false;
  var _realKeyDown = window.onkeydown;
  var _realKeyUp = window.onkeyup;

  function wrapHandler(realFn, evtName) {
    return function (e) {
      // If overlay is visible and the event target is inside the overlay
      // (or is an input/button), let the browser handle it normally
      if (overlayVisible) {
        var t = e.target || e.srcElement;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA' ||
            (t.closest && t.closest('#mp-overlay')))) {
          return;
        }
        // Even for non-overlay targets, don't let game process keys while overlay is up
        return;
      }
      if (realFn) return realFn.apply(this, arguments);
    };
  }

  // Override window.onkeydown/onkeyup with defineProperty so the game
  // can't bypass our wrapper by re-assigning the property
  try {
    Object.defineProperty(window, 'onkeydown', {
      get: function () { return wrapHandler(_realKeyDown, 'keydown'); },
      set: function (fn) { _realKeyDown = fn; },
      configurable: true
    });
    Object.defineProperty(window, 'onkeyup', {
      get: function () { return wrapHandler(_realKeyUp, 'keyup'); },
      set: function (fn) { _realKeyUp = fn; },
      configurable: true
    });
  } catch (e) {
    // Fallback: if defineProperty fails, use polling
    setInterval(function () {
      if (overlayVisible) {
        if (window.onkeydown && window.onkeydown._mpWrapped !== true) {
          _realKeyDown = window.onkeydown;
          var wrapped = wrapHandler(_realKeyDown, 'keydown');
          wrapped._mpWrapped = true;
          window.onkeydown = wrapped;
        }
        if (window.onkeyup && window.onkeyup._mpWrapped !== true) {
          _realKeyUp = window.onkeyup;
          var wrapped2 = wrapHandler(_realKeyUp, 'keyup');
          wrapped2._mpWrapped = true;
          window.onkeyup = wrapped2;
        }
      }
    }, 50);
  }

  // ── UI: Overlay System ──────────────────────────────────
  function getOverlay() {
    var el = $('mp-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mp-overlay';
      el.className = 'mp-overlay';
      document.body.appendChild(el);
    }
    return el;
  }

  function showOverlay(html) {
    var el = getOverlay();
    el.innerHTML = html;
    el.style.display = 'flex';
    overlayVisible = true;
  }

  function hideOverlay() {
    var el = $('mp-overlay');
    if (el) el.style.display = 'none';
    overlayVisible = false;
  }

  function showStatus(text) {
    var el = $('mp-status');
    if (el) el.textContent = text;
  }

  // ── UI: Lobby ───────────────────────────────────────────
  MP.showLobby = function () {
    MP.gamePhase = 'lobby';
    if (!initFirebase()) {
      showOverlay(
        '<h2>ERROR</h2><p>Firebase not loaded. Check your internet connection.</p>' +
        '<button class="mp-btn" onclick="MP.backToMenu()">BACK</button>'
      );
      return;
    }
    showLobbyUI();
  };

  function showLobbyUI() {
    showOverlay(
      '<h2>TWO PLAYER MATCH</h2>' +
      '<p style="color:#aaa;font-size:10px;">Enter a code to join, or leave blank to create a new game</p>' +
      '<input type="text" id="mp-code-input" class="mp-input" placeholder="GAME CODE" maxlength="6" autocomplete="off" />' +
      '<button class="mp-btn" onclick="MP.go()">GO</button>' +
      '<button class="mp-btn mp-btn-secondary" onclick="MP.backToMenu()">CANCEL</button>' +
      '<p id="mp-status"></p>'
    );
    setTimeout(function () {
      var inp = $('mp-code-input');
      if (inp) {
        inp.focus();
        // Stop game engine from swallowing keyboard input
        ['keydown', 'keyup', 'keypress'].forEach(function (evt) {
          inp.addEventListener(evt, function (e) {
            e.stopPropagation();
          });
        });
      }
    }, 100);
  }

  MP.go = function () {
    var code = ($('mp-code-input') || {}).value || '';
    if (code.trim().length > 0) {
      showStatus('Joining...');
      joinRoom(code.trim().toUpperCase(), function () {
        showReadyScreen();
        listenForOpponent();
      }, function (err) {
        showStatus(err);
      });
    } else {
      showStatus('Creating game...');
      createRoom(function (newCode) {
        MP.gamePhase = 'waiting';
        showWaitingForOpponent();
        listenForOpponent();
      });
    }
  };

  function showWaitingForOpponent() {
    showOverlay(
      '<h2>YOUR CODE</h2>' +
      '<div class="mp-code">' + MP.roomCode + '</div>' +
      '<p>Share this code with your opponent</p>' +
      '<p id="mp-status">Waiting for opponent...</p>' +
      '<button class="mp-btn mp-btn-secondary" onclick="MP.backToMenu()">CANCEL</button>'
    );
  }

  function showReadyScreen() {
    MP.gamePhase = 'lobby';
    showOverlay(
      '<h2>OPPONENT CONNECTED!</h2>' +
      '<p>Start a match in your game first, then press READY.</p>' +
      '<button class="mp-btn mp-btn-ready" onclick="MP.setReady()">READY</button>' +
      '<p id="mp-status"></p>'
    );
  }

  MP.setReady = function () {
    if (!roomRef) return;
    var teamName = 'Player ' + (MP.playerIndex + 1);
    try {
      var state = _6E2._Ue2(64);
      if (state && state._Ip !== undefined) {
        teamName = 'Team ' + state._Ip;
      }
    } catch (e) {}
    roomRef.child('players/' + MP.playerIndex).update({
      ready: true,
      teamName: teamName
    });
    showStatus('Waiting for opponent to ready up...');
  };

  function showCoinToss(youGoFirst) {
    showOverlay(
      '<h2>COIN TOSS</h2>' +
      '<p class="mp-big">' + (youGoFirst ? 'YOU GO FIRST!' : MP.opponentName + ' GOES FIRST') + '</p>' +
      '<p>Get ready...</p>'
    );
  }

  // ── UI: Turn Banner ─────────────────────────────────────
  function showTurnBanner(text) {
    var banner = $('mp-turn-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'mp-turn-banner';
      banner.className = 'mp-turn-banner';
      document.body.appendChild(banner);
    }
    banner.textContent = text;
    banner.style.display = 'block';
    banner.style.opacity = '1';
    hideOverlay();

    setTimeout(function () {
      banner.style.opacity = '0';
      setTimeout(function () { banner.style.display = 'none'; }, 500);
    }, 2500);
  }

  // ── UI: Scorebar ────────────────────────────────────────
  function updateScorebar() {
    var bar = $('mp-scorebar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mp-scorebar';
      bar.className = 'mp-scorebar';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '<span>YOU: <b>' + MP.myTotalScore + '</b></span>' +
      '<span>Q' + MP.quarter + ' | Drive ' + (MP.driveNum + 1) + '</span>' +
      '<span>' + MP.opponentName + ': <b>' + MP.opponentTotalScore + '</b></span>';
    bar.style.display = 'flex';
  }

  function hideScorebar() {
    var bar = $('mp-scorebar');
    if (bar) bar.style.display = 'none';
  }

  // ── UI: Spectate View ───────────────────────────────────
  function showSpectateView() {
    hideOverlay();
    var container = $('mp-spectate');
    if (!container) {
      container = document.createElement('div');
      container.id = 'mp-spectate';
      container.className = 'mp-spectate';

      var label = document.createElement('div');
      label.className = 'mp-spectate-label';
      label.textContent = MP.opponentName + ' IS PLAYING...';
      container.appendChild(label);

      var cv = document.createElement('canvas');
      cv.width = 480;
      cv.height = 270;
      cv.className = 'mp-spectate-canvas';
      container.appendChild(cv);
      document.body.appendChild(container);

      MP.spectateCanvas = cv;
      MP.spectateCtx = cv.getContext('2d');
      MP.spectateCtx.fillStyle = '#000';
      MP.spectateCtx.fillRect(0, 0, 480, 270);
    } else {
      var label2 = container.querySelector('.mp-spectate-label');
      if (label2) label2.textContent = MP.opponentName + ' IS PLAYING...';
    }
    container.style.display = 'flex';
  }

  function hideSpectateView() {
    var el = $('mp-spectate');
    if (el) el.style.display = 'none';
  }

  // ── UI: Game Over ───────────────────────────────────────
  function showGameOver(winner, yourIndex) {
    hideScorebar();
    hideSpectateView();
    var resultText;
    if (winner === -1) {
      resultText = 'TIE GAME!';
    } else if (winner === yourIndex) {
      resultText = 'YOU WIN!';
    } else {
      resultText = 'YOU LOSE!';
    }
    showOverlay(
      '<h2>GAME OVER</h2>' +
      '<p class="mp-big">' + resultText + '</p>' +
      '<div class="mp-final-scores">' +
        '<div>YOU: <b>' + MP.myTotalScore + '</b></div>' +
        '<div>' + MP.opponentName + ': <b>' + MP.opponentTotalScore + '</b></div>' +
      '</div>' +
      '<button class="mp-btn" onclick="MP.backToMenu()">BACK TO MENU</button>'
    );
  }

  // ── Back to Menu ────────────────────────────────────────
  MP.backToMenu = function () {
    MP.gamePhase = 'idle';
    MP.isMyTurn = false;
    stopFrameCapture();
    stopDriveMonitor();
    unblockInput();
    hideOverlay();
    hideScorebar();
    hideSpectateView();
    cleanupListeners();
    // Clean up room if we created it and no one joined
    if (roomRef) {
      roomRef.child('players/' + MP.playerIndex).remove();
      roomRef = null;
    }
    MP.roomCode = null;
    MP.playerIndex = -1;
  };

  // ── TWO PLAYER Button (shown on home screen) ───────────
  function createMPButton() {
    var btn = document.createElement('button');
    btn.id = 'mp-lobby-btn';
    btn.className = 'mp-btn mp-lobby-btn';
    btn.textContent = 'TWO PLAYER';
    btn.addEventListener('click', function () {
      MP.showLobby();
    });
    document.body.appendChild(btn);

    setInterval(function () {
      try {
        var room = _ft._gt();
        if (room === 14 || MP.gamePhase !== 'idle') {
          btn.style.display = 'none';
        } else {
          btn.style.display = 'block';
        }
      } catch (e) {
        btn.style.display = 'none';
      }
    }, 500);
  }

  // ── Room Cleanup (delete old rooms) ─────────────────────
  function cleanupOldRooms() {
    if (!db) return;
    var cutoff = Date.now() - 30 * 60 * 1000; // 30 min
    db.ref('rooms').orderByChild('createdAt').endAt(cutoff).once('value', function (snap) {
      snap.forEach(function (child) {
        child.ref.remove();
      });
    });
  }

  // ── Init ────────────────────────────────────────────────
  function init() {
    var checkReady = setInterval(function () {
      try {
        if (typeof _ft !== 'undefined' && typeof _6E2 !== 'undefined') {
          clearInterval(checkReady);
          createMPButton();
          // Cleanup old rooms occasionally
          if (initFirebase()) {
            cleanupOldRooms();
          }
        }
      } catch (e) {}
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
