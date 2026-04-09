const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
app.get('/health', (_req, res) => res.send('OK'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Room storage
const rooms = new Map();

// Generate 6-char room code (no ambiguous chars)
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

// Clean up stale rooms (30 min timeout)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > 30 * 60 * 1000) {
      for (const p of room.players) {
        if (p && p.ws.readyState === 1) {
          p.ws.send(JSON.stringify({ type: 'room_expired' }));
          p.ws.close();
        }
      }
      rooms.delete(code);
    }
  }
}, 60000);

function send(ws, msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function getOtherPlayer(room, ws) {
  return room.players.find(p => p && p.ws !== ws);
}

function handleMessage(ws, data, isBinary) {
  // Binary data = canvas frame, relay to other player
  if (isBinary) {
    const room = ws._room;
    if (!room) return;
    const other = getOtherPlayer(room, ws);
    if (other && other.ws.readyState === 1) {
      other.ws.send(data);
    }
    return;
  }

  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }

  switch (msg.type) {

    case 'create_room': {
      const code = generateCode();
      const room = {
        code,
        players: [{ ws, index: 0, ready: false, teamName: '' }],
        state: 'waiting',
        currentTurn: -1,
        quarter: 1,
        driveCount: 0,
        scores: [0, 0],
        lastActivity: Date.now()
      };
      rooms.set(code, room);
      ws._room = room;
      ws._playerIndex = 0;
      send(ws, { type: 'room_created', code });
      break;
    }

    case 'join_room': {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'error', message: 'Room not found' });
        return;
      }
      if (room.players.length >= 2) {
        send(ws, { type: 'error', message: 'Room is full' });
        return;
      }
      room.players.push({ ws, index: 1, ready: false, teamName: '' });
      room.lastActivity = Date.now();
      ws._room = room;
      ws._playerIndex = 1;
      send(ws, { type: 'room_joined', playerIndex: 1, code });
      send(room.players[0].ws, { type: 'opponent_joined' });
      break;
    }

    case 'player_ready': {
      const room = ws._room;
      if (!room) return;
      const player = room.players.find(p => p.ws === ws);
      if (!player) return;
      player.ready = true;
      player.teamName = msg.teamName || 'Player ' + (player.index + 1);
      room.lastActivity = Date.now();

      // Check if both ready
      if (room.players.length === 2 && room.players.every(p => p.ready)) {
        room.state = 'playing';
        // Coin toss - random first player
        room.currentTurn = Math.random() < 0.5 ? 0 : 1;
        room.quarter = 1;
        room.driveCount = 0;
        room.scores = [0, 0];

        for (const p of room.players) {
          send(p.ws, {
            type: 'game_start',
            firstPlayer: room.currentTurn,
            yourIndex: p.index,
            opponent: getOtherPlayer(room, p.ws).teamName
          });
        }

        // Tell first player to start
        setTimeout(() => {
          send(room.players[room.currentTurn].ws, {
            type: 'start_turn',
            quarter: room.quarter,
            driveNum: room.driveCount,
            scores: room.scores
          });
          const other = room.players[room.currentTurn === 0 ? 1 : 0];
          send(other.ws, {
            type: 'spectate',
            quarter: room.quarter,
            driveNum: room.driveCount,
            scores: room.scores
          });
        }, 3000);
      } else {
        // Notify the other player if they exist
        const other = getOtherPlayer(room, ws);
        if (other) send(other.ws, { type: 'opponent_ready', teamName: player.teamName });
      }
      break;
    }

    case 'drive_ended': {
      const room = ws._room;
      if (!room || room.state !== 'playing') return;
      room.lastActivity = Date.now();

      const pi = ws._playerIndex;
      const pointsThisDrive = msg.pointsThisDrive || 0;
      room.scores[pi] += pointsThisDrive;
      room.driveCount++;

      const reportedQuarter = msg.quarter || room.quarter;
      if (reportedQuarter > room.quarter) {
        room.quarter = reportedQuarter;
      }

      // Check game over: each player gets 8 drives (2 per quarter x 4 quarters)
      // or if a player reports game ended
      const totalDrivesPerPlayer = 8;
      const p0Drives = Math.ceil(room.driveCount / 2);
      const p1Drives = Math.floor(room.driveCount / 2);
      const firstPlayer = room.currentTurn; // who went first stays consistent

      if (msg.gameEnded || room.driveCount >= totalDrivesPerPlayer * 2) {
        room.state = 'finished';
        const winner = room.scores[0] > room.scores[1] ? 0 :
                       room.scores[1] > room.scores[0] ? 1 : -1;
        for (const p of room.players) {
          send(p.ws, {
            type: 'game_over',
            scores: room.scores,
            winner,
            yourIndex: p.index
          });
        }
        return;
      }

      // Switch turns
      const nextTurn = pi === 0 ? 1 : 0;
      room.currentTurn = nextTurn;

      // Notify both players
      send(room.players[nextTurn].ws, {
        type: 'start_turn',
        quarter: room.quarter,
        driveNum: room.driveCount,
        scores: room.scores
      });
      send(room.players[pi].ws, {
        type: 'spectate',
        quarter: room.quarter,
        driveNum: room.driveCount,
        scores: room.scores
      });
      break;
    }

    case 'game_ended': {
      // Player's in-game match reached post-match screen
      const room = ws._room;
      if (!room || room.state !== 'playing') return;
      room.lastActivity = Date.now();

      const pi = ws._playerIndex;
      room.scores[pi] = msg.finalScore || room.scores[pi];

      // Check if both players have finished
      const player = room.players.find(p => p.ws === ws);
      player.gameFinished = true;

      if (room.players.every(p => p.gameFinished)) {
        room.state = 'finished';
        const winner = room.scores[0] > room.scores[1] ? 0 :
                       room.scores[1] > room.scores[0] ? 1 : -1;
        for (const p of room.players) {
          send(p.ws, {
            type: 'game_over',
            scores: room.scores,
            winner,
            yourIndex: p.index
          });
        }
      }
      break;
    }

    case 'ping': {
      send(ws, { type: 'pong' });
      break;
    }
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    handleMessage(ws, data, isBinary);
  });

  ws.on('close', () => {
    const room = ws._room;
    if (!room) return;
    const other = getOtherPlayer(room, ws);
    if (other) {
      send(other.ws, { type: 'opponent_disconnected' });
    }
    // Remove the player
    room.players = room.players.filter(p => p.ws !== ws);
    // Clean up empty rooms
    if (room.players.length === 0) {
      rooms.delete(room.code);
    }
  });

  ws.on('error', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`2PlayerRB server running on port ${PORT}`);
});
