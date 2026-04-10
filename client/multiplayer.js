/*
 * 2PlayerRB — Multiplayer module for Retro Bowl (Firebase version)
 *
 * Turn model: Each player plays offense only (AI plays defense).
 * When your drive ends, the other player plays offense.
 * No AI offense — possession is hacked back to human after each drive.
 * 4 two-minute quarters, however many drives happen naturally.
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────
  var FRAME_INTERVAL_MS = 200; // 5 fps
  var FRAME_QUALITY = 0.3;
  var FRAME_WIDTH = 240;
  var FRAME_HEIGHT = 135;

  // ── Firebase ──────────────────────────────────────────────
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
    driveStartScore: 0,
    driveCycleState: 'idle', // idle | human_offense
    matchObjPolling: null,
    lastPossession: -1,
    lastRoom: -1,
    lastVy: -1,
    waitingForPAT: false,

    // Frame streaming
    frameInterval: null,
    spectateCanvas: null,
    spectateCtx: null,
    offscreenCanvas: null,
    offscreenCtx: null,

    // Firebase listeners
    listeners: []
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
    MP.listeners.forEach(function (l) { l.ref.off(l.event, l.fn); });
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
      if (snap.exists()) { createRoom(callback); return; }
      ref.set({
        state: 'waiting',
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        players: { 0: { teamName: 'Player 1' } },
        currentTurn: -1,
        quarter: 1,
        driveCount: 0,
        scores: { 0: 0, 1: 0 }
      }).then(function () {
        MP.roomCode = code;
        MP.playerIndex = 0;
        roomRef = ref;
        ref.child('players/0').onDisconnect().remove();
        callback(code);
      });
    });
  }

  function joinRoom(code, callback, errorCallback) {
    var ref = db.ref('rooms/' + code);
    ref.once('value', function (snap) {
      if (!snap.exists()) { errorCallback('Room not found'); return; }
      var room = snap.val();
      if (room.players && room.players[1]) { errorCallback('Room is full'); return; }
      if (room.state !== 'waiting') { errorCallback('Game already started'); return; }
      ref.child('players/1').set({ teamName: 'Player 2' }).then(function () {
        MP.roomCode = code;
        MP.playerIndex = 1;
        roomRef = ref;
        ref.child('players/1').onDisconnect().remove();
        callback();
      });
    });
  }

  // ── Auto-Start: Listen for opponent and start game ──────
  function listenForOpponent() {
    listen(roomRef.child('players'), 'value', function (snap) {
      var players = snap.val();
      if (!players) return;

      // Track opponent name
      var oppIdx = MP.playerIndex === 0 ? 1 : 0;
      if (players[oppIdx]) {
        MP.opponentName = players[oppIdx].teamName || ('Player ' + (oppIdx + 1));
      }

      // Both players present → auto-start
      if (players[0] && players[1]) {
        if (MP.gamePhase === 'waiting') {
          startGame();
        }
      }

      // Opponent disconnected during game
      if (MP.gamePhase === 'playing' || MP.gamePhase === 'spectating') {
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
    // Prevent double-start
    if (MP.gamePhase === 'playing' || MP.gamePhase === 'spectating') return;

    roomRef.once('value', function (snap) {
      var room = snap.val();
      if (room.state === 'playing') return;

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

  // ── Local Game Freeze (Anti-AI) ─────────────────────────
  var freezeInterval = null;
  function startFreezeLocalGame() {
    stopFreezeLocalGame();
    freezeInterval = setInterval(function () {
      if (MP.gamePhase !== 'spectating') return;
      try {
        var m = _6E2 && _6E2._Ue2 && _6E2._Ue2(71);
        if (m) hackPossessionBack(m);
      } catch (e) {}
    }, 50); // Hammer it 20 times a second to destroy the AI state machine
  }

  function stopFreezeLocalGame() {
    if (freezeInterval) {
      clearInterval(freezeInterval);
      freezeInterval = null;
    }
  }

  // ── Turn Management ─────────────────────────────────────
  function onMyTurnStart() {
    hideSpectateView();
    unblockInput();
    updateScorebar();
    stopFreezeLocalGame();

    // Navigate to match if not already there
    try {
      var room = _ft._gt();
      if (room !== 14) {
        _Hj(14);
      }
    } catch (e) {}

    // Short delay for match to load, then start monitoring
    setTimeout(function () {
      startFrameCapture();
      startDriveMonitor();
    }, 1000);

    showTurnBanner('YOUR TURN — PLAY OFFENSE!');
  }

  function onSpectateStart() {
    stopFrameCapture();
    stopDriveMonitor();
    blockInput();
    showSpectateView();
    updateScorebar();
    listenForFrames();
    startFreezeLocalGame();
  }

  // ── Drive End Detection (NO AI OFFENSE) ─────────────────
  function startDriveMonitor() {
    stopDriveMonitor();
    MP.driveCycleState = 'idle';
    MP.driveStartScore = getCurrentHumanScore();

    MP.matchObjPolling = setInterval(function () {
      try {
        var room = _ft._gt();

        // Match ended naturally (went to post-match screen)
        if (room === 22 && MP.lastRoom === 14) {
          var finalScore = getCurrentHumanScore();
          var points = finalScore - MP.driveStartScore;
          stopDriveMonitor();
          endDrive(points, true);
          return;
        }
        MP.lastRoom = room;
        if (room !== 14) return;

        var m = _6E2._Ue2(71);
        if (!m) return;

        var possession = m._UD;
        var humanTeam = m._0z;
        var scores = m._Sb1;

        // State: idle → waiting for human to get the ball
        if (MP.driveCycleState === 'idle') {
          if (possession === humanTeam) {
            MP.driveCycleState = 'human_offense';
            MP.driveStartScore = scores ? scores[humanTeam] : 0;
          } else {
             // Force ball to human on their own 25 yard line to start their drive
             hackPossessionBack(m);
          }
        }
        // State: human_offense → playing, watching for drive end
        else if (MP.driveCycleState === 'human_offense') {
          
          // If human loses possession FOR ANY REASON (Interception, Fumble, Punt, FG, post-TD kickoff)
          // The drive is OVER instantly.
          if (possession !== humanTeam) {
            var earned = (scores ? scores[humanTeam] : 0) - MP.driveStartScore;
            // IMMEDIATELY FORCE BALL BACK TO HUMAN! 
            // This freezes the local game engine at the line of scrimmage so the AI doesn't play in the background!
            hackPossessionBack(m);
            stopDriveMonitor();
            endDrive(earned, false);
            return;
          }
        }
      } catch (e) {}
    }, 200);
  }

  function stopDriveMonitor() {
    if (MP.matchObjPolling) {
      clearInterval(MP.matchObjPolling);
      MP.matchObjPolling = null;
    }
  }

  // ── Possession Hack: Force ball back to human ───────────
  function hackPossessionBack(m) {
    try {
      m._UD = m._0z;       // Give possession back to human
      m._Vy = 2;           // Set to possession/waiting state
      m._l61 = 10;         // Reset yards to first down
      m._6F = -75;         // Reset field position (own 25 yard line)
      m._831 = '';         // Clear play call
      m._t11 = 1;          // Reset timer flag
      m._8c1 = 0;          // Reset counter
    } catch (e) {}
  }

  function endDrive(pointsThisDrive, gameEnded) {
    stopFrameCapture();
    blockInput();

    // The user EXPLICITLY requested the screen must turn black immediately upon turnover. 
    // Do not wait for Firebase event syncing.
    MP.gamePhase = 'spectating';
    showSpectateView();
    startFreezeLocalGame();

    if (!roomRef) return;

    roomRef.once('value', function (snap) {
      var room = snap.val();
      if (!room) return;

      var newScores = room.scores || { 0: 0, 1: 0 };
      newScores[MP.playerIndex] = (newScores[MP.playerIndex] || 0) + pointsThisDrive;
      var newDriveCount = (room.driveCount || 0) + 1;

      if (gameEnded) {
        roomRef.update({
          state: 'finished',
          scores: newScores,
          driveCount: newDriveCount
        });
        return;
      }

      var nextTurn = MP.playerIndex === 0 ? 1 : 0;
      roomRef.update({
        currentTurn: nextTurn,
        scores: newScores,
        driveCount: newDriveCount,
        frame: null
      });
    });

    showTurnBanner('DRIVE COMPLETE — OPPONENT\'S TURN!');
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
  // re-registers window.onkeydown/onkeyup with preventDefault() handlers.
  // We intercept all writes via Object.defineProperty so typing works in
  // our overlay inputs.
  var overlayVisible = false;
  var _realKeyDown = window.onkeydown;
  var _realKeyUp = window.onkeyup;

  function wrapHandler(realFn) {
    return function (e) {
      if (e.type === 'keydown' && e.key && e.key.toLowerCase() === 'b') {
        if (MP.gamePhase === 'playing') {
           // Manual blackout / end turn fail-safe
           MP.gamePhase = 'spectating';
           showSpectateView();
           startFreezeLocalGame();
           stopDriveMonitor();
           endDrive(0, false);
           return;
        }
      }
      if (overlayVisible) return;
      if (MP.gamePhase === 'spectating') return;
      if (realFn) return realFn.apply(this, arguments);
    };
  }

  try {
    Object.defineProperty(window, 'onkeydown', {
      get: function () { return wrapHandler(_realKeyDown); },
      set: function (fn) { _realKeyDown = fn; },
      configurable: true
    });
    Object.defineProperty(window, 'onkeyup', {
      get: function () { return wrapHandler(_realKeyUp); },
      set: function (fn) { _realKeyUp = fn; },
      configurable: true
    });
  } catch (e) {
    setInterval(function () {
      if (overlayVisible) {
        if (window.onkeydown) { _realKeyDown = window.onkeydown; window.onkeydown = null; }
        if (window.onkeyup) { _realKeyUp = window.onkeyup; window.onkeyup = null; }
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
        ['keydown', 'keyup', 'keypress'].forEach(function (evt) {
          inp.addEventListener(evt, function (e) { e.stopPropagation(); });
        });
      }
    }, 100);
  }

  MP.go = function () {
    var code = ($('mp-code-input') || {}).value || '';
    if (code.trim().length > 0) {
      showStatus('Joining...');
      joinRoom(code.trim().toUpperCase(), function () {
        MP.gamePhase = 'waiting';
        showOverlay(
          '<h2>JOINED!</h2>' +
          '<p>Waiting for game to start...</p>' +
          '<p id="mp-status"></p>'
        );
        listenForOpponent();
      }, function (err) {
        showStatus(err);
      });
    } else {
      showStatus('Creating game...');
      createRoom(function (newCode) {
        MP.gamePhase = 'waiting';
        showOverlay(
          '<h2>YOUR CODE</h2>' +
          '<div class="mp-code">' + MP.roomCode + '</div>' +
          '<p>Share this code with your opponent</p>' +
          '<p id="mp-status">Waiting for opponent to join...</p>' +
          '<button class="mp-btn mp-btn-secondary" onclick="MP.backToMenu()">CANCEL</button>'
        );
        listenForOpponent();
      });
    }
  };

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
      '<span>Drive ' + (MP.driveNum + 1) + '</span>' +
      '<span>' + (MP.opponentName || 'OPP') + ': <b>' + MP.opponentTotalScore + '</b></span>';
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
      label.textContent = (MP.opponentName || 'OPPONENT') + ' IS PLAYING OFFENSE...';
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
      if (label2) label2.textContent = (MP.opponentName || 'OPPONENT') + ' IS PLAYING OFFENSE...';
    }
    container.style.display = 'flex';
  }

  function hideSpectateView() {
    var el = $('mp-spectate');
    if (el) el.style.display = 'none';
  }

  // ── UI: Game Over ───────────────────────────────────────
  function showGameOver(winner, yourIndex) {
    stopFreezeLocalGame();
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
        '<div>' + (MP.opponentName || 'OPP') + ': <b>' + MP.opponentTotalScore + '</b></div>' +
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
    stopFreezeLocalGame();
    unblockInput();
    hideOverlay();
    hideScorebar();
    hideSpectateView();
    cleanupListeners();
    if (roomRef) {
      roomRef.child('players/' + MP.playerIndex).remove();
      roomRef = null;
    }
    MP.roomCode = null;
    MP.playerIndex = -1;
  };

  // ── TWO PLAYER Button ──────────────────────────────────
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

  // ── Room Cleanup ───────────────────────────────────────
  function cleanupOldRooms() {
    if (!db) return;
    var cutoff = Date.now() - 30 * 60 * 1000;
    db.ref('rooms').orderByChild('createdAt').endAt(cutoff).once('value', function (snap) {
      snap.forEach(function (child) { child.ref.remove(); });
    });
  }

  // ── Init ────────────────────────────────────────────────
  function init() {
    var checkReady = setInterval(function () {
      try {
        if (typeof _ft !== 'undefined' && typeof _6E2 !== 'undefined') {
          clearInterval(checkReady);
          createMPButton();
          if (initFirebase()) cleanupOldRooms();
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
