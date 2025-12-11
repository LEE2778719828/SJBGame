const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let CONFIG;
try {
    CONFIG = JSON.parse(fs.readFileSync('config.json'));
} catch (e) {
    CONFIG = { 
        MAX_HP: 10, ROUND_TIME_SEC: 5.0, SHOW_TIME_SEC: 2.0,
        CRIT_WARMUP_SEC: 1.0, CRIT_TIME_SEC: 4.0, CRIT_SETTLE_SEC: 3.0,
        DMG_AFK: 1.5, DMG_HIT: 1.0, MAX_AFK_ROUNDS: 2,
        CRIT_TRIGGER_N: 1, CRIT_DMG_PER_TAP: 0.2
    };
}

app.use(express.static(path.join(__dirname, 'public')));

let waitingPlayer = null;
const rooms = {};

function tryMatch(socket) {
    if (waitingPlayer) {
        if (waitingPlayer.id === socket.id) return;
        
        const roomId = `room_${Date.now()}_${Math.floor(Math.random()*1000)}`;
        const opponent = waitingPlayer;
        waitingPlayer = null;

        socket.join(roomId);
        opponent.join(roomId);

        const room = {
            id: roomId,
            players: [opponent.id, socket.id],
            names: { [opponent.id]: opponent.playerName, [socket.id]: socket.playerName },
            hp: { [opponent.id]: CONFIG.MAX_HP, [socket.id]: CONFIG.MAX_HP },
            moves: { [opponent.id]: null, [socket.id]: null },
            afkCount: { [opponent.id]: 0, [socket.id]: 0 },
            streak: { [opponent.id]: 0, [socket.id]: 0 },
            critAttacker: null,
            critVictim: null,
            critTotalDmg: 0,
            state: 'playing', 
            nextPhaseTime: Date.now() + (CONFIG.ROUND_TIME_SEC * 1000) + 1000 
        };
        rooms[roomId] = room;

        io.to(roomId).emit('gameStart', {
            roomId: roomId,
            players: room.players,
            names: room.names, 
            hp: room.hp,
            nextPhaseTime: room.nextPhaseTime,
            config: CONFIG
        });

        startGameLoop(roomId);
    } else {
        waitingPlayer = socket;
        socket.emit('status', 'Waiting for opponent...');
    }
}

io.on('connection', (socket) => {
    const rawName = socket.handshake.query.name;
    socket.playerName = (rawName && rawName.length > 0) ? rawName : `Player${socket.id.substr(0,4)}`;

    socket.on('syncTime', (clientTime, callback) => {
        callback({ serverTime: Date.now(), clientTime: clientTime });
    });

    tryMatch(socket);
    socket.on('playAgain', () => { tryMatch(socket); });

    socket.on('makeMove', ({ roomId, move }) => {
        const room = rooms[roomId];
        if (!room || room.state !== 'playing') return;
        if (room.moves[socket.id]) return;
        
        room.moves[socket.id] = move;
        socket.emit('moveConfirmed', move);

        // --- 修复逻辑 1: 秒结算 ---
        const otherId = room.players.find(id => id !== socket.id);
        if (room.moves[otherId]) {
            // 双方都操作了，无需等待倒计时，立即结算
            // 将 nextPhaseTime 设为当前时间，下一帧循环会立即触发 resolveRound
            room.nextPhaseTime = Date.now();
        }
    });

    socket.on('critTap', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.state !== 'crit_active') return;
        if (room.critAttacker !== socket.id) return;

        const victimId = room.critVictim;
        const dmg = CONFIG.CRIT_DMG_PER_TAP;
        
        room.hp[victimId] = Math.max(0, room.hp[victimId] - dmg);
        room.critTotalDmg += dmg;

        io.to(roomId).emit('critUpdate', { hp: room.hp, totalDmg: room.critTotalDmg });

        if (room.hp[victimId] <= 0) {
            handleGameOver(roomId, socket.id, 'ko', null);
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
        for (const rid in rooms) {
            if (rooms[rid].players.includes(socket.id)) {
                 handleGameOver(rid, rooms[rid].players.find(id=>id!==socket.id), 'afk', socket.id);
            }
        }
    });
});

function startGameLoop(roomId) {
    const interval = setInterval(() => {
        const room = rooms[roomId];
        if (!room) { clearInterval(interval); return; }

        const now = Date.now();
        if (now >= room.nextPhaseTime) {
            switch (room.state) {
                case 'playing':
                    resolveRound(roomId);
                    break;
                case 'showing_result':
                    startNewRound(room);
                    break;
                case 'crit_warmup':
                    room.state = 'crit_active';
                    room.nextPhaseTime = now + (CONFIG.CRIT_TIME_SEC * 1000);
                    room.critTotalDmg = 0;
                    io.to(roomId).emit('critStart', { 
                        attackerId: room.critAttacker,
                        victimId: room.critVictim,
                        nextPhaseTime: room.nextPhaseTime
                    });
                    break;
                case 'crit_active':
                    // 暴击阶段结束，进入结算展示阶段
                    room.state = 'crit_settle';
                    // 这个时间必须足够长，且在这段时间内服务器 NOT sending newRound
                    room.nextPhaseTime = now + (CONFIG.CRIT_SETTLE_SEC * 1000);
                    io.to(roomId).emit('critResult', {
                        totalDmg: room.critTotalDmg,
                        nextPhaseTime: room.nextPhaseTime
                    });
                    break;
                case 'crit_settle':
                    // 只有等 settlement 时间完全跑完，才开始新一轮
                    startNewRound(room);
                    break;
            }
        }
    }, 50); // 50ms 刷新率保证秒结算响应快
}

function startNewRound(room) {
    room.state = 'playing';
    room.nextPhaseTime = Date.now() + (CONFIG.ROUND_TIME_SEC * 1000);
    room.moves = { [room.players[0]]: null, [room.players[1]]: null };
    // 发送新回合指令，客户端收到后必须立即解锁 UI
    io.to(room.id).emit('newRound', { nextPhaseTime: room.nextPhaseTime });
}

function resolveRound(roomId) {
    const room = rooms[roomId];
    if(!room) return; 

    const p1 = room.players[0];
    const p2 = room.players[1];
    const m1 = room.moves[p1];
    const m2 = room.moves[p2];

    let dmg1 = 0, dmg2 = 0;
    
    if (!m1) { dmg1 += CONFIG.DMG_AFK; room.afkCount[p1]++; } else room.afkCount[p1] = 0;
    if (!m2) { dmg2 += CONFIG.DMG_AFK; room.afkCount[p2]++; } else room.afkCount[p2] = 0;

    let roundWinner = null;
    if (m1 && m2) {
        if (m1 !== m2) {
            if (
                (m1 === 'rock' && m2 === 'scissors') || 
                (m1 === 'scissors' && m2 === 'paper') || 
                (m1 === 'paper' && m2 === 'rock')
            ) {
                dmg2 += CONFIG.DMG_HIT; roundWinner = p1;
            } else {
                dmg1 += CONFIG.DMG_HIT; roundWinner = p2;
            }
        }
    } else if (m1 && !m2) roundWinner = p1;
    else if (!m1 && m2) roundWinner = p2;

    if (roundWinner) {
        room.streak[roundWinner]++;
        room.streak[roundWinner === p1 ? p2 : p1] = 0;
    } else {
        room.streak[p1] = 0; room.streak[p2] = 0;
    }

    room.hp[p1] = Math.max(0, room.hp[p1] - dmg1);
    room.hp[p2] = Math.max(0, room.hp[p2] - dmg2);

    io.to(roomId).emit('roundResult', {
        moves: { [p1]: m1, [p2]: m2 },
        damages: { [p1]: dmg1, [p2]: dmg2 },
        hp: room.hp,
        streak: room.streak
    });

    const hpZero = room.hp[p1] <= 0 || room.hp[p2] <= 0;
    const p1Afk = room.afkCount[p1] >= CONFIG.MAX_AFK_ROUNDS;
    const p2Afk = room.afkCount[p2] >= CONFIG.MAX_AFK_ROUNDS;

    if (hpZero || p1Afk || p2Afk) {
        let winner = null, reason = '', afkUserId = null;
        if (p1Afk && p2Afk) { reason = 'both_afk'; }
        else if (p1Afk) { winner = p2; reason = 'afk'; afkUserId = p1; }
        else if (p2Afk) { winner = p1; reason = 'afk'; afkUserId = p2; }
        else if (hpZero) { reason = 'ko'; winner = room.hp[p1] > room.hp[p2] ? p1 : p2; }
        setTimeout(() => handleGameOver(roomId, winner, reason, afkUserId), 1000);
        return; 
    }

    if (roundWinner && room.streak[roundWinner] >= CONFIG.CRIT_TRIGGER_N) {
        room.state = 'crit_warmup';
        room.critAttacker = roundWinner;
        room.critVictim = (roundWinner === p1) ? p2 : p1;
        room.nextPhaseTime = Date.now() + (CONFIG.CRIT_WARMUP_SEC * 1000); 
    } else {
        room.state = 'showing_result';
        room.nextPhaseTime = Date.now() + (CONFIG.SHOW_TIME_SEC * 1000);
    }
}

function handleGameOver(roomId, winnerId, reason, afkUserId) {
    if(!rooms[roomId]) return;
    io.to(roomId).emit('gameOver', { winnerId, reason, afkUserId });
    delete rooms[roomId];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));