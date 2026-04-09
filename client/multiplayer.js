/*
 * 2PlayerRB — Multiplayer module for Retro Bowl
 * Handles WebSocket connection, lobby UI, turn management,
 * canvas streaming, drive detection, and scoreboard.
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────
  // Replace with your Render deployment URL
  var SERVER_URL = 'wss://two-player-rb.onrender.com';
  var FRAME_INTERVAL_MS = 100; // 10 fps
  var FRAME_QUALITY = 0.45;

  // ── State ───────────────────────────────────────────────
  var MP = window.MP = {
    ws: null,
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
    driveCycleState: 'idle', // idle | human_offense | ai_offense | ready_to_switch
    matchObjPolling: null,

    // Frame streaming
    frameInterval: null,
    spectateCanvas: null,
    spectateCtx: null,

    // Keepalive
    pingInterval: null
  };

  // ── Utility ─────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function sendJSON(msg) {
    if (MP.ws && MP.ws.readyState === 1) {
      MP.ws.send(JSON.stringify(msg));
    }
  }

  // ── WebSocket Connection ────────────────────────────────
  function connect(callback) {
    if (MP.ws && MP.ws.readyState <= 1) {
      if (callback) callback();
      return;
    }
    showStatus('Connecting to server...');
    MP.ws = new WebSocket(SERVER_URL);
    MP.ws.binaryType = 'blob';

    MP.ws.onopen = function () {
      showStatus('Connected!');
      // Keepalive every 25s
      MP.pingInterval = setInterval(function () { sendJSON({ type: 'ping' }); }, 25000);
      if (callback) callback();
    };

    MP.ws.onmessage = function (event) {
      if (event.data instanceof Blob) {
        onFrameReceived(event.data);
        return;
      }
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      handleServerMessage(msg);
    };

    MP.ws.onclose = function () {
      clearInterval(MP.pingInterval);
      if (MP.gamePhase !== 'idle' && MP.gamePhase !== 'finished') {
        showStatus('Disconnected from server. Reconnecting...');
        setTimeout(function () { connect(); }, 3000);
      }
    };

    MP.ws.onerror = function () {
      showStatus('Connection error. Retrying...');
    };
  }

  // ── Server Message Handler ──────────────────────────────
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'room_created':
        MP.roomCode = msg.code;
        showWaitingForOpponent();
        break;

      case 'room_joined':
        MP.playerIndex = msg.playerIndex;
        MP.roomCode = msg.code;
        showReadyScreen();
        break;

      case 'opponent_joined':
        showReadyScreen();
        break;

      case 'opponent_ready':
        MP.opponentName = msg.teamName;
        showStatus('Opponent (' + msg.teamName + ') is ready!');
        break;

      case 'game_start':
        MP.playerIndex = msg.yourIndex;
        MP.opponentName = msg.opponent;
        MP.myTotalScore = 0;
        MP.opponentTotalScore = 0;
        showCoinToss(msg.firstPlayer === msg.yourIndex);
        break;

      case 'start_turn':
        MP.isMyTurn = true;
        MP.gamePhase = 'playing';
        MP.quarter = msg.quarter;
        MP.driveNum = msg.driveNum;
        if (msg.scores) {
          MP.myTotalScore = msg.scores[MP.playerIndex];
          MP.opponentTotalScore = msg.scores[MP.playerIndex === 0 ? 1 : 0];
        }
        onMyTurnStart();
        break;

      case 'spectate':
        MP.isMyTurn = false;
        MP.gamePhase = 'spectating';
        MP.quarter = msg.quarter;
        MP.driveNum = msg.driveNum;
        if (msg.scores) {
          MP.myTotalScore = msg.scores[MP.playerIndex];
          MP.opponentTotalScore = msg.scores[MP.playerIndex === 0 ? 1 : 0];
        }
        onSpectateStart();
        break;

      case 'game_over':
        MP.gamePhase = 'finished';
        MP.myTotalScore = msg.scores[msg.yourIndex];
        MP.opponentTotalScore = msg.scores[msg.yourIndex === 0 ? 1 : 0];
        stopFrameCapture();
        stopDriveMonitor();
        unblockInput();
        showGameOver(msg.winner, msg.yourIndex);
        break;

      case 'opponent_disconnected':
        if (MP.gamePhase !== 'finished') {
          showOverlay('<h2>OPPONENT DISCONNECTED</h2><p>You win by forfeit!</p>' +
            '<button class="mp-btn" onclick="MP.backToMenu()">BACK</button>');
          MP.gamePhase = 'finished';
          stopFrameCapture();
          stopDriveMonitor();
          unblockInput();
        }
        break;

      case 'room_expired':
        showOverlay('<h2>ROOM EXPIRED</h2><button class="mp-btn" onclick="MP.backToMenu()">BACK</button>');
        MP.gamePhase = 'idle';
        break;

      case 'error':
        showStatus(msg.message || 'Error');
        break;
    }
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
  }

  // ── Drive End Detection ─────────────────────────────────
  // Poll game state to detect when a drive cycle completes.
  // A "drive cycle" = human plays offense → AI plays offense → next human possession starts
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

        // Game reached post-match screen
        if (room === 22 && MP.lastRoom === 14) {
          clearInterval(MP.matchObjPolling);
          var finalScore = getCurrentHumanScore();
          var points = finalScore - MP.driveStartScore;
          sendJSON({ type: 'game_ended', finalScore: MP.myTotalScore + points });
          return;
        }
        MP.lastRoom = room;
        if (room !== 14) return; // only monitor during match

        // Try to read match controller (instance 71)
        var m = _6E2._Ue2(71);
        if (!m) return;

        var commStage = m._Vy;
        var possession = m._UD;
        var quarter = m._Wy;
        var humanTeam = m._0z;
        var scores = m._Sb1;

        // Track drive cycle state machine
        if (MP.driveCycleState === 'idle') {
          // Wait until we see human on offense
          if (possession === humanTeam) {
            MP.driveCycleState = 'human_offense';
            MP.driveStartScore = scores ? scores[humanTeam] : 0;
          }
        } else if (MP.driveCycleState === 'human_offense') {
          // Human drive ended when possession flips to AI
          if (possession !== humanTeam && MP.lastPossession === humanTeam) {
            MP.driveCycleState = 'ai_offense';
          }
          // Or if quarter ends / game ends
          if (commStage === 17 && MP.lastCommStage !== 17) {
            MP.driveCycleState = 'ai_offense';
          }
        } else if (MP.driveCycleState === 'ai_offense') {
          // AI drive ended when possession flips back to human
          if (possession === humanTeam && MP.lastPossession !== humanTeam) {
            // Full cycle complete — time to switch
            var currentScore = scores ? scores[humanTeam] : 0;
            var pointsThisDrive = currentScore - MP.driveStartScore;
            endDrive(pointsThisDrive, quarter);
            return;
          }
          // Or if end of quarter during AI drive
          if (commStage === 17 && MP.lastCommStage !== 17 && quarter !== MP.lastQuarter) {
            var currentScore2 = scores ? scores[humanTeam] : 0;
            var pointsThisDrive2 = currentScore2 - MP.driveStartScore;
            endDrive(pointsThisDrive2, quarter);
            return;
          }
        }

        MP.lastCommStage = commStage;
        MP.lastPossession = possession;
        MP.lastQuarter = quarter;
      } catch (e) {
        // Game state not ready yet
      }
    }, 200);
  }

  function stopDriveMonitor() {
    if (MP.matchObjPolling) {
      clearInterval(MP.matchObjPolling);
      MP.matchObjPolling = null;
    }
  }

  function endDrive(pointsThisDrive, quarter) {
    stopDriveMonitor();
    stopFrameCapture();
    blockInput();
    sendJSON({
      type: 'drive_ended',
      pointsThisDrive: pointsThisDrive,
      quarter: quarter
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
    if (!canvas) return;

    MP.frameInterval = setInterval(function () {
      if (!MP.isMyTurn || !MP.ws || MP.ws.readyState !== 1) return;
      try {
        canvas.toBlob(function (blob) {
          if (blob && MP.ws && MP.ws.readyState === 1) {
            MP.ws.send(blob);
          }
        }, 'image/jpeg', FRAME_QUALITY);
      } catch (e) {}
    }, FRAME_INTERVAL_MS);
  }

  function stopFrameCapture() {
    if (MP.frameInterval) {
      clearInterval(MP.frameInterval);
      MP.frameInterval = null;
    }
  }

  function onFrameReceived(blob) {
    if (MP.gamePhase !== 'spectating') return;
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      if (MP.spectateCtx) {
        MP.spectateCtx.drawImage(img, 0, 0, MP.spectateCanvas.width, MP.spectateCanvas.height);
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
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
  }

  function hideOverlay() {
    var el = $('mp-overlay');
    if (el) el.style.display = 'none';
  }

  function showStatus(text) {
    var el = $('mp-status');
    if (el) el.textContent = text;
  }

  // ── UI: Lobby ───────────────────────────────────────────
  MP.showLobby = function () {
    MP.gamePhase = 'lobby';
    connect(function () {
      showOverlay(
        '<h2>TWO PLAYER MATCH</h2>' +
        '<button class="mp-btn" onclick="MP.createRoom()">CREATE ROOM</button>' +
        '<button class="mp-btn" onclick="MP.showJoinRoom()">JOIN ROOM</button>' +
        '<button class="mp-btn mp-btn-secondary" onclick="MP.backToMenu()">CANCEL</button>' +
        '<p id="mp-status"></p>'
      );
    });
  };

  MP.createRoom = function () {
    sendJSON({ type: 'create_room' });
    showOverlay(
      '<h2>CREATING ROOM...</h2>' +
      '<p id="mp-status">Connecting...</p>'
    );
  };

  MP.showJoinRoom = function () {
    showOverlay(
      '<h2>JOIN ROOM</h2>' +
      '<input type="text" id="mp-code-input" class="mp-input" placeholder="ENTER CODE" maxlength="6" autocomplete="off" />' +
      '<button class="mp-btn" onclick="MP.joinRoom()">JOIN</button>' +
      '<button class="mp-btn mp-btn-secondary" onclick="MP.showLobby()">BACK</button>' +
      '<p id="mp-status"></p>'
    );
    setTimeout(function () {
      var inp = $('mp-code-input');
      if (inp) inp.focus();
    }, 100);
  };

  MP.joinRoom = function () {
    var code = ($('mp-code-input') || {}).value || '';
    if (code.length < 4) {
      showStatus('Enter a valid room code');
      return;
    }
    sendJSON({ type: 'join_room', code: code });
    showStatus('Joining...');
  };

  function showWaitingForOpponent() {
    showOverlay(
      '<h2>ROOM CREATED</h2>' +
      '<div class="mp-code">' + MP.roomCode + '</div>' +
      '<p>Share this code with your opponent</p>' +
      '<p id="mp-status">Waiting for opponent to join...</p>' +
      '<button class="mp-btn mp-btn-secondary" onclick="MP.backToMenu()">CANCEL</button>'
    );
  }

  function showReadyScreen() {
    showOverlay(
      '<h2>ROOM: ' + MP.roomCode + '</h2>' +
      '<p>Opponent connected!</p>' +
      '<p>Start a match in your game first, then press READY.</p>' +
      '<button class="mp-btn mp-btn-ready" onclick="MP.setReady()">READY</button>' +
      '<p id="mp-status"></p>'
    );
  }

  MP.setReady = function () {
    var teamName = 'Player ' + (MP.playerIndex + 1);
    try {
      var state = _6E2._Ue2(64);
      if (state && state._Ip !== undefined) {
        teamName = 'Team ' + state._Ip;
      }
    } catch (e) {}
    sendJSON({ type: 'player_ready', teamName: teamName });
    showStatus('Waiting for opponent to ready up...');
  };

  function showCoinToss(youGoFirst) {
    showOverlay(
      '<h2>COIN TOSS</h2>' +
      '<p class="mp-big">' + (youGoFirst ? 'YOU GO FIRST!' : MP.opponentName + ' GOES FIRST') + '</p>' +
      '<p>Get ready...</p>'
    );
    // Auto-dismiss after 3s (server sends start_turn/spectate after 3s)
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
      // Fill black initially
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
    if (MP.ws) {
      MP.ws.close();
      MP.ws = null;
    }
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

    // Show/hide based on game room
    setInterval(function () {
      try {
        var room = _ft._gt();
        // Show on home screen (room 13) or master menu (room 1)
        btn.style.display = (room === 13 || room === 1) ? 'block' : 'none';

        // Also hide during active multiplayer
        if (MP.gamePhase !== 'idle') {
          btn.style.display = 'none';
        }
      } catch (e) {
        btn.style.display = 'none';
      }
    }, 500);
  }

  // ── Init ────────────────────────────────────────────────
  function init() {
    // Wait for game engine to be ready
    var checkReady = setInterval(function () {
      try {
        if (typeof _ft !== 'undefined' && typeof _6E2 !== 'undefined') {
          clearInterval(checkReady);
          createMPButton();
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
