'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const DATA_FILE = path.join(DATA_DIR, 'online-data.json');
const INDEX_FILE = path.join(ROOT, 'index.html');
const CONFIG_FILE = path.join(ROOT, 'online-config.js');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const BOARD_SIZE = 5;
const TURN_MS = 60 * 1000;
const SHAPES = ['triangle', 'circle', 'arrow'];
const RANKS = ['学徒', '见习棋手', '正式棋手', '中阶棋手', '高阶棋手', '传奇棋手', '规则棋手', '真理棋手', '始祖棋手'];
const RANK_REQUIREMENTS = [50, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000];
const DIRS = [
  { dr: -1, dc: 0, dir: 0 },
  { dr: 0, dc: 1, dir: 1 },
  { dr: 1, dc: 0, dir: 2 },
  { dr: 0, dc: -1, dir: 3 }
];

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { nextUserId: 1, users: {}, sessions: {}, usernames: {} };
try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = {
      nextUserId: parsed.nextUserId || 1,
      users: parsed.users || {},
      sessions: parsed.sessions || {},
      usernames: parsed.usernames || {}
    };
  }
} catch (err) {
  console.error('Could not read online-data.json:', err.message);
}

function normalizeUsername(value) {
  return String(value || '').normalize('NFKC').trim();
}

function usernameKey(value) {
  return normalizeUsername(value).toLowerCase();
}

// Rebuild the unique username index from users (this also upgrades old data files).
db.usernames = db.usernames || {};
for (const user of Object.values(db.users)) {
  const key = usernameKey(user.username);
  user.usernameLower = key;
  if (!db.usernames[key]) db.usernames[key] = user.id;
  if (user.rank >= 2) user.shiftUnlocked = true;
  if (user.winStreak === undefined) user.winStreak = 0;
  if (user.lastWinGain === undefined) user.lastWinGain = 10;
}

function saveData() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function otherColor(color) {
  return color === 'red' ? 'blue' : 'red';
}

function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array.from({ length: BOARD_SIZE }, () => []));
}

function makePieces() {
  return { triangle: 5, circle: 5, arrow: 5 };
}

function cellHasShape(cell, shape) {
  return cell.some(piece => piece.shape === shape);
}

function countOwned(cell, color) {
  return cell.filter(piece => piece.owner === color).length;
}

function cellIsFull(cell) {
  return SHAPES.every(shape => cellHasShape(cell, shape));
}

function scoreKey(r, c, color) {
  return `${r},${c},${color}`;
}

function targetCells(lastPiece) {
  if (!lastPiece) {
    const list = [];
    for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) list.push({ r, c });
    return list;
  }
  if (lastPiece.shape === 'triangle') {
    const list = [];
    for (const d of DIRS) {
      const r = lastPiece.r + d.dr;
      const c = lastPiece.c + d.dc;
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) list.push({ r, c });
    }
    return list;
  }
  if (lastPiece.shape === 'circle') return [{ r: lastPiece.r, c: lastPiece.c }];
  if (lastPiece.shape === 'arrow') {
    if (lastPiece.arrowTarget) return [{ r: lastPiece.arrowTarget.r, c: lastPiece.arrowTarget.c }];
    const d = DIRS[lastPiece.dir];
    if (!d) return [];
    const r = lastPiece.r + d.dr;
    const c = lastPiece.c + d.dc;
    return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE ? [{ r, c }] : [];
  }
  return [];
}

function collectLegal(room, color) {
  const targets = room.freeMove || !room.lastPiece
    ? targetCells(null)
    : targetCells(room.lastPiece);
  const pieces = room.pieces[color];
  const moves = [];
  for (const { r, c } of targets) {
    const cell = room.board[r][c];
    for (const shape of SHAPES) {
      if (pieces[shape] <= 0 || cellHasShape(cell, shape)) continue;
      if (shape === 'arrow') {
        if (room.mode === 'shift') {
          for (let dir = 0; dir < DIRS.length; dir++) {
            for (let distance = 1; distance <= pieces.arrow; distance++) {
              const nr = r + DIRS[dir].dr * distance;
              const nc = c + DIRS[dir].dc * distance;
              if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) break;
              moves.push({
                r,
                c,
                shape,
                dir,
                shiftTarget: { r: nr, c: nc },
                shiftCost: distance
              });
            }
          }
        } else {
          for (let dir = 0; dir < DIRS.length; dir++) {
            const nr = r + DIRS[dir].dr;
            const nc = c + DIRS[dir].dc;
            if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE) {
              moves.push({ r, c, shape, dir });
            }
          }
        }
      } else {
        moves.push({ r, c, shape, dir: null });
      }
    }
  }
  return moves;
}

function totalPieces(room, color) {
  return SHAPES.reduce((sum, shape) => sum + room.pieces[color][shape], 0);
}

function winnerByScore(room) {
  if (room.scores.red > room.scores.blue) return 'red';
  if (room.scores.blue > room.scores.red) return 'blue';
  return null;
}

function endRoom(room, winner, zh, en) {
  if (room.gameOver) return;
  room.gameOver = true;
  room.winner = winner || null;
  room.reasonZh = zh;
  room.reasonEn = en;
  room.pendingUndo = null;
  room.turnStartedAt = Date.now();
  room.version += 1;
  userRoom.delete(room.userIds.red);
  userRoom.delete(room.userIds.blue);
  if (!room.ranked) {
    room.ranked = true;
    for (const color of ['red', 'blue']) {
      const user = db.users[room.userIds[color]];
      if (!user) continue;
      applyOnlineResult(
        user,
        !winner ? 'draw' : winner === color ? 'win' : 'loss',
        room.mode === 'shift' ? 2 : 1
      );
    }
    saveData();
  }
}

function applyOnlineResult(user, outcome, multiplier = 1) {
  if (outcome === 'win') {
    user.wins = (user.wins || 0) + 1;
    user.winStreak = (user.winStreak || 0) + 1;
    let gain = 10;
    if (user.winStreak === 3) gain = 12;
    else if (user.winStreak > 3 && user.winStreak < 10) gain = Math.round((user.lastWinGain || 10) * 1.2);
    else if (user.winStreak >= 10) gain = Math.round((user.lastWinGain || 10) * 1.5);
    user.lastWinGain = gain;
    user.bestStreak = Math.max(user.bestStreak || 0, user.winStreak);
    user.points = (user.points || 0) + gain * multiplier;
    while (user.rank < RANKS.length - 1 && user.points >= RANK_REQUIREMENTS[user.rank]) {
      user.points -= RANK_REQUIREMENTS[user.rank];
      user.rank += 1;
      user.protection = false;
      if (user.rank >= 2) user.shiftUnlocked = true;
    }
    if (user.rank >= RANKS.length - 1) user.points = Math.max(0, user.points);
    return;
  }
  if (outcome === 'draw') {
    user.draws = (user.draws || 0) + 1;
    user.winStreak = 0;
    user.lastWinGain = 10;
    return;
  }

  user.losses = (user.losses || 0) + 1;
  user.winStreak = 0;
  user.lastWinGain = 10;
  const basePenalty = user.rank <= 1 ? 0 : user.rank <= 5 ? 5 : 10;
  const penalty = basePenalty * multiplier;
  if (!penalty) return;
  user.points = (user.points || 0) - penalty;
  if (user.points >= 0) return;

  if (user.rank === 0) {
    user.points = 0;
    return;
  }
  if (!user.protection) {
    user.points = 0;
    user.protection = true;
    return;
  }
  user.rank -= 1;
  user.points = 0;
  user.protection = false;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    rank: user.rank,
    rankName: RANKS[user.rank],
    points: user.points,
    nextRequirement: user.rank < RANKS.length - 1 ? RANK_REQUIREMENTS[user.rank] : null,
    protection: !!user.protection,
    wins: user.wins || 0,
    losses: user.losses || 0,
    draws: user.draws || 0,
    winStreak: user.winStreak || 0,
    lastWinGain: user.lastWinGain || 10,
    bestStreak: user.bestStreak || 0,
    shiftUnlocked: !!user.shiftUnlocked || user.rank >= 2
  };
}

function rankInfoForUser(user) {
  return publicUser(user);
}

const rooms = new Map();
const matchQueue = [];
const userRoom = new Map();

function roomId() {
  return crypto.randomBytes(5).toString('hex');
}

function createRoom(userA, userB, mode = 'classic') {
  const id = roomId();
  const aRed = Math.random() < 0.5;
  const redUser = aRed ? userA : userB;
  const blueUser = aRed ? userB : userA;
  const pieces = mode === 'shift' ? 7 : 5;
  const room = {
    id,
    mode,
    createdAt: Date.now(),
    userIds: { red: redUser.id, blue: blueUser.id },
    names: { red: redUser.username, blue: blueUser.username },
    board: emptyBoard(),
    pieces: {
      red: { triangle: 5, circle: 5, arrow: pieces },
      blue: { triangle: 5, circle: 5, arrow: pieces }
    },
    scores: { red: 0, blue: 0 },
    scored: new Set(),
    turn: 'red',
    freeMove: true,
    lastPiece: null,
    lastEventZh: '',
    lastEventEn: '',
    moveCount: 0,
    history: [],
    undoLeft: { red: 3, blue: 3 },
    pendingUndo: null,
    gameOver: false,
    winner: null,
    reasonZh: '',
    reasonEn: '',
    timeouts: { red: 0, blue: 0 },
    turnStartedAt: Date.now(),
    version: 1,
    ranked: false
  };
  rooms.set(id, room);
  userRoom.set(redUser.id, id);
  userRoom.set(blueUser.id, id);
  return room;
}

function colorForUser(room, userId) {
  if (room.userIds.red === userId) return 'red';
  if (room.userIds.blue === userId) return 'blue';
  return null;
}

function cloneBoardState(board) {
  return board.map(row => row.map(cell => cell.map(piece => ({
    ...piece,
    ...(piece.arrowTarget ? { arrowTarget: { ...piece.arrowTarget } } : {})
  }))));
}

function snapshotRoomState(room) {
  return {
    board: cloneBoardState(room.board),
    pieces: {
      red: { ...room.pieces.red },
      blue: { ...room.pieces.blue }
    },
    scores: { red: room.scores.red, blue: room.scores.blue },
    scored: new Set(room.scored),
    turn: room.turn,
    freeMove: room.freeMove,
    lastPiece: room.lastPiece
      ? { ...room.lastPiece, ...(room.lastPiece.arrowTarget ? { arrowTarget: { ...room.lastPiece.arrowTarget } } : {}) }
      : null,
    moveCount: room.moveCount
  };
}

function pushRoomHistory(room) {
  room.history.push(snapshotRoomState(room));
}

function undoHistoryIndex(room, color) {
  for (let i = room.history.length - 1; i >= 0; i--) {
    if (room.history[i].turn === color) return i;
  }
  return -1;
}

function restoreRoomState(room, snapshot) {
  room.board = snapshot.board;
  room.pieces = snapshot.pieces;
  room.scores = snapshot.scores;
  room.scored = snapshot.scored;
  room.turn = snapshot.turn;
  room.freeMove = snapshot.freeMove;
  room.lastPiece = snapshot.lastPiece;
  room.moveCount = snapshot.moveCount;
}

function canUndoServer(room, color) {
  return !room.gameOver && !room.pendingUndo && room.undoLeft[color] > 0 && undoHistoryIndex(room, color) >= 0;
}

function checkTimeout(room) {
  if (room.gameOver) return;
  if (room.pendingUndo) return;
  if (Date.now() - room.turnStartedAt < TURN_MS) return;
  const color = room.turn;
  room.timeouts[color] += 1;
  if (room.timeouts[color] >= 3) {
    endRoom(
      room,
      otherColor(color),
      `${room.names[color]}累计三次超时，${room.names[otherColor(color)]}获胜。`,
      `${room.names[color]} timed out three times; ${room.names[otherColor(color)]} wins.`
    );
    return;
  }
  room.turn = otherColor(color);
  room.freeMove = true;
  room.turnStartedAt = Date.now();
  room.version += 1;
  room.lastEventZh = `${room.names[color]}超时，${room.names[room.turn]}获得任意棋。`;
  room.lastEventEn = `${room.names[color]} timed out; ${room.names[room.turn]} receives a free move.`;
}

function applyForcedFreeMove(room) {
  if (room.gameOver) return;
  if (collectLegal(room, room.turn).length > 0) return;
  const stuck = room.turn;
  const targets = room.freeMove || !room.lastPiece ? targetCells(null) : targetCells(room.lastPiece);
  const exhausted = targets.some(({ r, c }) => !cellIsFull(room.board[r][c]));
  if (exhausted) {
    const beneficiary = otherColor(stuck);
    room.turn = beneficiary;
    room.freeMove = true;
    if (collectLegal(room, beneficiary).length === 0) {
      endRoom(room, null, '双方都没有可落子的位置，本局平局。', 'Neither side has a legal placement. The game is a draw.');
      return;
    }
    room.lastEventZh = `${room.names[stuck]}可用棋子耗尽，本轮停一手；${room.names[beneficiary]}获得任意棋。`;
    room.lastEventEn = `${room.names[stuck]} has no available piece and skips the turn; ${room.names[beneficiary]} receives a free move.`;
  } else {
    room.freeMove = true;
    if (collectLegal(room, stuck).length === 0) {
      endRoom(room, null, '当前玩家没有任何可落子的位置，本局平局。', 'The current player has no legal placement. The game is a draw.');
      return;
    }
    room.lastEventZh = `${room.names[stuck]}的目标格已满，获得任意棋。`;
    room.lastEventEn = `${room.names[stuck]}'s target cell is full and receives a free move.`;
  }
  room.version += 1;
}

function applyMove(room, color, move) {
  const legal = collectLegal(room, color);
  const chosen = legal.find(candidate => {
    if (candidate.r !== move.r || candidate.c !== move.c || candidate.shape !== move.shape) return false;
    if ((candidate.dir ?? null) !== (move.dir ?? null)) return false;
    if (room.mode === 'shift' && candidate.shape === 'arrow') {
      return !!move.shiftTarget &&
        candidate.shiftTarget.r === move.shiftTarget.r &&
        candidate.shiftTarget.c === move.shiftTarget.c &&
        candidate.shiftCost === move.shiftCost;
    }
    return true;
  });
  if (!chosen) return { ok: false, error: 'Illegal move.' };

  pushRoomHistory(room);
  const shiftCost = room.mode === 'shift' && chosen.shape === 'arrow' ? chosen.shiftCost : 1;
  const shiftTarget = room.mode === 'shift' && chosen.shiftTarget ? chosen.shiftTarget : null;
  const cell = room.board[chosen.r][chosen.c];
  cell.push({
    owner: color,
    shape: chosen.shape,
    dir: chosen.dir ?? null,
    ...(shiftTarget ? { arrowTarget: { ...shiftTarget }, shiftCost } : {})
  });
  room.pieces[color][chosen.shape] -= shiftCost;
  room.moveCount += 1;
  room.lastPiece = {
    owner: color,
    shape: chosen.shape,
    dir: chosen.dir ?? null,
    r: chosen.r,
    c: chosen.c,
    ...(shiftTarget ? { arrowTarget: { ...shiftTarget }, shiftCost } : {})
  };
  room.freeMove = false;
  room.turnStartedAt = Date.now();

  let gained = false;
  if (!room.scored.has(scoreKey(chosen.r, chosen.c, color)) && countOwned(cell, color) >= 2) {
    room.scored.add(scoreKey(chosen.r, chosen.c, color));
    room.scores[color] += 1;
    gained = true;
  }
  if (shiftTarget) {
    room.lastEventZh = `${room.names[color]}在 ${chosen.r + 1},${chosen.c + 1} 使用移形换影，消耗 ${shiftCost} 枚箭头棋，指定对手下一步只能落在 ${shiftTarget.r + 1},${shiftTarget.c + 1}${gained ? '，并引发圣器共鸣！' : '。'}`;
    room.lastEventEn = `${room.names[color]} used Shifting Arrow from ${chosen.r + 1},${chosen.c + 1}, spent ${shiftCost} Arrows and forced the next move to ${shiftTarget.r + 1},${shiftTarget.c + 1}${gained ? ' and scored a Hallow Resonance!' : '.'}`;
  } else {
    room.lastEventZh = `${room.names[color]}在 ${chosen.r + 1},${chosen.c + 1} 落子${gained ? '，圣器共鸣 +1！' : '。'}`;
    room.lastEventEn = `${room.names[color]} placed a piece${gained ? ' and scored a Hallow Resonance!' : '.'}`;
  }

  if (room.scores[color] >= 3) {
    endRoom(
      room,
      color,
      `${room.names[color]}率先达成 3 点圣器共鸣，获得胜利。`,
      `${room.names[color]} reached three Hallow Resonances and wins.`
    );
    return { ok: true };
  }
  if (totalPieces(room, 'red') === 0 || totalPieces(room, 'blue') === 0) {
    const winner = winnerByScore(room);
    endRoom(
      room,
      winner,
      winner
        ? `双方棋子耗尽，${room.names[winner]}以 ${room.scores[winner]} : ${room.scores[otherColor(winner)]} 获胜。`
        : `双方棋子耗尽，比分 ${room.scores.red} : ${room.scores.blue}，本局平局。`,
      winner
        ? `The pieces are exhausted; ${room.names[winner]} wins ${room.scores[winner]} : ${room.scores[otherColor(winner)]}.`
        : `The pieces are exhausted; the game is a ${room.scores.red} : ${room.scores.blue} draw.`
    );
    return { ok: true };
  }

  room.turn = otherColor(color);
  room.freeMove = false;
  room.version += 1;
  applyForcedFreeMove(room);
  return { ok: true };
}

function roomSnapshot(room, color) {
  checkTimeout(room);
  const user = db.users[room.userIds[color]];
  return {
    roomId: room.id,
    mode: room.mode,
    color,
    names: { red: room.names.red, blue: room.names.blue },
    labels: { red: room.names.red, blue: room.names.blue },
    board: room.board,
    scores: { red: room.scores.red, blue: room.scores.blue },
    pieces: { red: { ...room.pieces.red }, blue: { ...room.pieces.blue } },
    scored: Array.from(room.scored),
    turn: room.turn,
    freeMove: room.freeMove,
    lastPiece: room.lastPiece,
    moveCount: room.moveCount,
    gameOver: room.gameOver,
    winner: room.winner,
    reasonZh: room.reasonZh,
    reasonEn: room.reasonEn,
    eventZh: room.lastEventZh,
    eventEn: room.lastEventEn,
    timeouts: { red: room.timeouts.red, blue: room.timeouts.blue },
    turnTimeLeft: room.gameOver
      ? 0
      : room.pendingUndo
        ? room.pendingUndo.remaining
        : Math.max(0, Math.ceil((TURN_MS - (Date.now() - room.turnStartedAt)) / 1000)),
    undoLeft: { red: room.undoLeft.red, blue: room.undoLeft.blue },
    undoAvailable: {
      red: canUndoServer(room, 'red'),
      blue: canUndoServer(room, 'blue')
    },
    pendingUndo: room.pendingUndo
      ? {
        requester: room.pendingUndo.requester,
        requesterName: room.names[room.pendingUndo.requester]
      }
      : null,
    version: room.version,
    rank: user ? rankInfoForUser(user) : null
  };
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function authUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = db.sessions[token];
  if (!session) return null;
  const user = db.users[session.userId];
  if (!user) return null;
  return user;
}

function validUsername(name) {
  return typeof name === 'string' && /^[\p{L}\p{N}_-]{2,12}$/u.test(name);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: user.id, createdAt: Date.now() };
  saveData();
  return token;
}

function queueIndexOf(userId) {
  return matchQueue.findIndex(entry => entry.userId === userId);
}

function removeFromQueue(userId) {
  const i = queueIndexOf(userId);
  if (i >= 0) matchQueue.splice(i, 1);
}

function matchTolerance(waitMs) {
  if (waitMs >= 40000) return { rank: 8, points: Infinity, streak: Infinity };
  if (waitMs >= 20000) return { rank: 2, points: 500, streak: 20 };
  if (waitMs >= 10000) return { rank: 1, points: 250, streak: 10 };
  if (waitMs >= 4000) return { rank: 0, points: 100, streak: 5 };
  return { rank: 0, points: 30, streak: 2 };
}

function tryMatchQueue() {
  const now = Date.now();
  let best = null;
  for (let i = 0; i < matchQueue.length; i++) {
    const a = matchQueue[i];
    const ua = db.users[a.userId];
    if (!ua) continue;
    if (activeRoomFor(a.userId)) continue;
    for (let j = i + 1; j < matchQueue.length; j++) {
      const b = matchQueue[j];
      const ub = db.users[b.userId];
      if (!ub) continue;
      if (a.mode !== b.mode) continue;
      if (activeRoomFor(b.userId)) continue;
      const ta = matchTolerance(now - a.since);
      const tb = matchTolerance(now - b.since);
      const rankDiff = Math.abs(ua.rank - ub.rank);
      const pointDiff = Math.abs(ua.points - ub.points);
      const streakDiff = Math.abs((ua.winStreak || 0) - (ub.winStreak || 0));
      if (rankDiff > Math.max(ta.rank, tb.rank)) continue;
      if (pointDiff > Math.max(ta.points, tb.points)) continue;
      if (streakDiff > Math.max(ta.streak, tb.streak)) continue;
      const score = rankDiff * 1000000000
        + pointDiff * 10000
        + streakDiff * 100
        + (now - Math.min(a.since, b.since)) * 0.001;
      if (!best || score < best.score) best = { a, b, ua, ub, score };
    }
  }
  if (!best) return null;
  removeFromQueue(best.a.userId);
  removeFromQueue(best.b.userId);
  return createRoom(best.ua, best.ub, best.a.mode);
}

function activeRoomFor(userId) {
  const id = userRoom.get(userId);
  if (!id) return null;
  const room = rooms.get(id);
  if (!room) return null;
  return room;
}

function matchResponseFor(userId) {
  const room = activeRoomFor(userId);
  if (room) {
    const color = colorForUser(room, userId);
    if (room.gameOver) {
      userRoom.delete(userId);
      return { status: 'idle' };
    }
    return { status: 'matched', roomId: room.id, color, names: room.names, mode: room.mode };
  }
  if (queueIndexOf(userId) >= 0) return { status: 'queued' };
  return { status: 'idle' };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end();
    return;
  }

  try {
    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      if (!validUsername(username)) {
        return json(res, 400, { error: '用户名需为 2–12 个字符，只能包含文字、数字、下划线或短横线。' });
      }
      if (password.length < 6 || password.length > 64) {
        return json(res, 400, { error: '密码需为 6–64 个字符。' });
      }
      const lower = usernameKey(username);
      if (db.usernames[lower] || Object.values(db.users).some(user => user.usernameLower === lower)) {
        return json(res, 409, { error: '该用户名已被使用。' });
      }
      const id = String(db.nextUserId++);
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        id,
        username,
        usernameLower: lower,
        salt,
        hash: hashPassword(password, salt),
        rank: 0,
        points: 0,
        protection: false,
        shiftUnlocked: false,
        wins: 0,
        losses: 0,
        draws: 0,
        createdAt: Date.now()
      };
      db.users[id] = user;
      db.usernames[lower] = id;
      const token = createSession(user);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const username = usernameKey(body.username);
      const password = String(body.password || '');
      const indexedId = db.usernames[username];
      const user = (indexedId && db.users[indexedId])
        || Object.values(db.users).find(item => item.usernameLower === username);
      if (!user || !password) return json(res, 401, { error: '用户名或密码错误。' });
      const hash = hashPassword(password, user.salt);
      if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))) {
        return json(res, 401, { error: '用户名或密码错误。' });
      }
      const token = createSession(user);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, service: 'deathly-hallows-chess' });
    }

    const user = authUser(req);
    if (!user) return json(res, 401, { error: '请先登录。' });

    if (pathname === '/api/me' && req.method === 'GET') {
      return json(res, 200, { user: publicUser(user) });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      delete db.sessions[token];
      saveData();
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/match' && req.method === 'POST') {
      const body = await readBody(req);
      const mode = body.mode === 'shift' ? 'shift' : 'classic';
      if (mode === 'shift' && !(user.shiftUnlocked || user.rank >= 2)) {
        return json(res, 403, { error: '移形换影需要正式棋手段位解锁。' });
      }
      const existing = activeRoomFor(user.id);
      if (existing && !existing.gameOver) {
        return json(res, 200, {
          status: 'matched',
          roomId: existing.id,
          color: colorForUser(existing, user.id),
          names: existing.names,
          mode: existing.mode
        });
      }
      if (existing && existing.gameOver) {
        userRoom.delete(user.id);
      }
      removeFromQueue(user.id);
      matchQueue.push({ userId: user.id, since: Date.now(), mode });
      const room = tryMatchQueue();
      if (room) {
        return json(res, 200, {
          status: 'matched',
          roomId: room.id,
          color: colorForUser(room, user.id),
          names: room.names,
          mode: room.mode
        });
      }
      return json(res, 200, { status: 'queued', mode });
    }

    if (pathname === '/api/match/status' && req.method === 'GET') {
      const room = tryMatchQueue();
      if (room) {
        const color = colorForUser(room, user.id);
        if (color) {
          return json(res, 200, {
            status: 'matched',
            roomId: room.id,
            color,
            names: room.names,
            mode: room.mode
          });
        }
      }
      return json(res, 200, matchResponseFor(user.id));
    }

    if (pathname === '/api/match/cancel' && req.method === 'POST') {
      removeFromQueue(user.id);
      return json(res, 200, { status: 'idle' });
    }

    if (pathname === '/api/room' && req.method === 'GET') {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = String(parsedUrl.searchParams.get('id') || '');
      const room = rooms.get(id);
      if (!room) return json(res, 404, { error: '房间不存在。' });
      const color = colorForUser(room, user.id);
      if (!color) return json(res, 403, { error: '你不在这个房间中。' });
      return json(res, 200, roomSnapshot(room, color));
    }

    if (pathname === '/api/room/action' && req.method === 'POST') {
      const body = await readBody(req);
      const room = rooms.get(String(body.roomId || ''));
      if (!room) return json(res, 404, { error: '房间不存在。' });
      const color = colorForUser(room, user.id);
      if (!color) return json(res, 403, { error: '你不在这个房间中。' });
      checkTimeout(room);
      if (room.gameOver) return json(res, 200, roomSnapshot(room, color));

      if (body.type === 'undoRequest') {
        if (room.pendingUndo) return json(res, 409, { error: '已有悔棋申请正在等待处理。' });
        const targetIndex = undoHistoryIndex(room, color);
        if (room.undoLeft[color] <= 0) return json(res, 409, { error: '本局悔棋机会已经用完。' });
        if (targetIndex < 0) return json(res, 409, { error: '还没有可回溯的己方轮次。' });
        const remaining = Math.max(0, Math.ceil((TURN_MS - (Date.now() - room.turnStartedAt)) / 1000));
        room.undoLeft[color] -= 1;
        room.pendingUndo = {
          requester: color,
          targetIndex,
          at: Date.now(),
          remaining
        };
        room.version += 1;
        room.lastEventZh = `${room.names[color]}发起悔棋，等待 ${room.names[otherColor(color)]} 同意。`;
        room.lastEventEn = `${room.names[color]} requested an undo; waiting for ${room.names[otherColor(color)]}.`;
        return json(res, 200, roomSnapshot(room, color));
      }

      if (body.type === 'undoRespond') {
        const pending = room.pendingUndo;
        if (!pending) return json(res, 409, { error: '没有待处理的悔棋申请。' });
        if (pending.requester === color) return json(res, 409, { error: '不能处理自己的悔棋申请。' });
        const approve = !!body.approve;
        room.pendingUndo = null;
        if (approve) {
          const snapshot = room.history[pending.targetIndex];
          if (!snapshot) return json(res, 409, { error: '悔棋目标已经失效。' });
          restoreRoomState(room, snapshot);
          room.history = room.history.slice(0, pending.targetIndex);
          room.turnStartedAt = Date.now();
          room.lastEventZh = `${room.names[otherColor(color)]}的悔棋申请已获同意，棋局回溯。`;
          room.lastEventEn = `${room.names[otherColor(color)]}'s undo request was approved; the game was rolled back.`;
        } else {
          const remaining = Math.max(0, Math.min(60, Number(pending.remaining) || 0));
          room.turnStartedAt = Date.now() - (TURN_MS - remaining * 1000);
          room.lastEventZh = `${room.names[color]}拒绝了 ${room.names[otherColor(color)]} 的悔棋申请。`;
          room.lastEventEn = `${room.names[color]} declined ${room.names[otherColor(color)]}'s undo request.`;
        }
        room.version += 1;
        return json(res, 200, roomSnapshot(room, color));
      }

      if (room.pendingUndo) {
        return json(res, 409, { error: '悔棋申请等待处理中，暂时不能落子。' });
      }

      if (body.type === 'resign' || body.type === 'leave') {
        endRoom(
          room,
          otherColor(color),
          `${room.names[color]}${body.type === 'leave' ? '离开了对局' : '认输'}，${room.names[otherColor(color)]}获胜。`,
          `${room.names[color]} ${body.type === 'leave' ? 'left the match' : 'resigned'}; ${room.names[otherColor(color)]} wins.`
        );
        return json(res, 200, roomSnapshot(room, color));
      }

      if (body.type === 'move') {
        if (room.turn !== color) return json(res, 409, { error: '还没轮到你。' });
        const result = applyMove(room, color, body.move || {});
        if (!result.ok) return json(res, 400, { error: result.error || '无法落子。' });
        return json(res, 200, roomSnapshot(room, color));
      }

      return json(res, 400, { error: '未知操作。' });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: '服务器错误。' });
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (parsed.pathname.startsWith('/api/')) {
    return handleApi(req, res, parsed.pathname);
  }
  if (parsed.pathname === '/online-config.js') {
    try {
      const config = fs.readFileSync(CONFIG_FILE);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(config);
    } catch (err) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end('window.DC_ONLINE_API = "";\n');
    }
    return;
  }
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end('index.html not found');
    }
    return;
  }
  if (parsed.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Deathly Hallows Chess server listening on http://127.0.0.1:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
