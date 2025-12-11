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
    // 默认配置兜底
    CONFIG = { 
        MAX_HP: 10, ROUND_TIME_SEC: [5.0], SHOW_TIME_SEC: 2.0,
        CRIT_WARMUP_SEC: 1.0, CRIT_TIME_SEC: 4.0, CRIT_SETTLE_SEC: 3.0,
        DMG_AFK: 1.5, DMG_HIT: 1.0, MAX_AFK_ROUNDS: 2,
        CRIT_TRIGGER_N: 1, CRIT_DMG_PER_TAP: 0.2
    };
}

function getRoundDuration(roundIndex) {
    const rts = CONFIG.ROUND_TIME_SEC;
    if (!Array.isArray(rts)) return rts;
    const idx = Math.min(roundIndex, rts.length - 1);
    return rts[idx];
}

app.use(express.static(path.join(__dirname, 'public')));

// --- 修改：使用对象来管理不同模式的等待队列 ---
const waitingQueues = {
    'classic': null,
    'skill': null
};
// ----------------------------------------

const rooms = {};

function tryMatch(socket) {
    // 获取模式，默认为 classic
    const mode = socket.gameMode || 'classic';
    let waitingPlayer = waitingQueues[mode];

    if (waitingPlayer) {
        if (waitingPlayer.id === socket.id) return;
        
        // 匹配成功，清空该队列
        waitingQueues[mode] = null;

        const roomId = `room_${mode}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
        const opponent = waitingPlayer;
        
        socket.join(roomId);
        opponent.join(roomId);

        // 初始第一轮时间
        const firstRoundTime = getRoundDuration(0);

        const room = {
            id: roomId,
            mode: mode, // 记录房间模式
            players: [opponent.id, socket.id],
            names: { [opponent.id]: opponent.playerName, [socket.id]: socket.playerName },
            hp: { [opponent.id]: CONFIG.MAX_HP, [socket.id]: CONFIG.MAX_HP },
            moves: { [opponent.id]: null, [socket.id]: null },
            afkCount: { [opponent.id]: 0, [socket.id]: 0 },
            streak: { [opponent.id]: 0, [socket.id]: 0 },
            
            roundCount: 0,
            
            critAttacker: null,
            critVictim: null,
            critTotalDmg: 0,
            state: 'playing', 
            nextPhaseTime: Date.now() + (firstRoundTime * 1000) + 1000 
        };
        rooms[roomId] = room;

        io.to(roomId).emit('gameStart', {
            roomId: roomId,
            players: room.players,
            names: room.names, 
            hp: room.hp,
            nextPhaseTime: room.nextPhaseTime,
            config: CONFIG,
            mode: mode
        });

        startGameLoop(roomId);
    } else {
        // 没有对手，进入该模式的等待队列
        waitingQueues[mode] = socket;
        socket.emit('status', `Waiting for ${mode} opponent...`);
    }
}

io.on('connection', (socket) => {
    const rawName = socket.handshake.query.name;
    // 获取连接时指定的模式
    socket.gameMode = socket.handshake.query.mode || 'classic';
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

        // 秒结算逻辑
        const otherId = room.players.find(id => id !== socket.id);
        if (room.moves[otherId]) {
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
        // --- 修改：从对应的模式队列中移除 ---
        if (waitingQueues[socket.gameMode] === socket) {
            waitingQueues[socket.gameMode] = null;
        }

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
                    room.state = 'crit_settle';
                    room.nextPhaseTime = now + (CONFIG.CRIT_SETTLE_SEC * 1000);
                    io.to(roomId).emit('critResult', {
                        totalDmg: room.critTotalDmg,
                        nextPhaseTime: room.nextPhaseTime
                    });
                    break;
                case 'crit_settle':
                    startNewRound(room);
                    break;
            }
        }
    }, 50); 
}

function startNewRound(room) {
    room.state = 'playing';
    room.roundCount++; 
    const nextDuration = getRoundDuration(room.roundCount);
    
    room.nextPhaseTime = Date.now() + (nextDuration * 1000);
    room.moves = { [room.players[0]]: null, [room.players[1]]: null };
    
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
        // [关键修复] 立即改变状态，防止 gameLoop 重复进入此逻辑
        room.state = 'game_over_pending'; 
        
        let winner = null, reason = '', afkUserId = null;
        if (p1Afk && p2Afk) { reason = 'both_afk'; }
        else if (p1Afk) { winner = p2; reason = 'afk'; afkUserId = p1; }
        else if (p2Afk) { winner = p1; reason = 'afk'; afkUserId = p2; }
        else if (hpZero) { reason = 'ko'; winner = room.hp[p1] > room.hp[p2] ? p1 : p2; }
        
        // 延时执行真正的销毁逻辑
        setTimeout(() => handleGameOver(roomId, winner, reason, afkUserId), 1000);
        return; 
    }

    if (roundWinner && room.streak[roundWinner] >= CONFIG.CRIT_TRIGGER_N) {
        room.state = 'crit_warmup';
        room.critAttacker = roundWinner;
        room.critVictim = (roundWinner === p1) ? p2 : p1;
        room.streak[roundWinner] = 0;//重置胜者的获胜次数为0
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