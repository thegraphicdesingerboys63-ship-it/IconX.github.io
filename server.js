/**
 * IconX Hero Arena - Cloud Multiplayer Server
 */

const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

// Data Storage
const players = new Map();
const accounts = new Map();
const games = new Map();
const matchmakingQueue = [];
const privateRooms = new Map();

// Constants
const PLAYERS_PER_MATCH = 10;
const KILLS_TO_WIN = 50;
const TICK_RATE = 60;

const HEROES = [
    { id: 'blaze', name: 'Blaze', health: 200, speed: 5, attackDamage: 25 },
    { id: 'frost', name: 'Frost', health: 200, speed: 5, attackDamage: 20 },
    { id: 'shadow', name: 'Shadow', health: 150, speed: 7, attackDamage: 35 },
    { id: 'titan', name: 'Titan', health: 400, speed: 3, attackDamage: 15 },
    { id: 'healer', name: 'Sage', health: 175, speed: 4, attackDamage: 10 },
    { id: 'sniper', name: 'Hawk', health: 150, speed: 4, attackDamage: 45 }
];

// Utility Functions
function generateFriendCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function broadcast(gameId, message) {
    const game = games.get(gameId);
    if (!game) return;
    const data = JSON.stringify(message);
    game.players.forEach(player => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(data);
        }
    });
}

function sendToPlayer(playerId, message) {
    const player = players.get(playerId);
    if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
    }
}

function broadcastToRoom(roomCode, message) {
    const room = privateRooms.get(roomCode);
    if (!room) return;
    const data = JSON.stringify(message);
    room.players.forEach(roomPlayer => {
        const player = players.get(roomPlayer.id);
        if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(data);
        }
    });
}

// Game State Class
class GameState {
    constructor(gameId, isPrivateRoom = false) {
        this.id = gameId;
        this.players = new Map();
        this.bots = new Map();
        this.projectiles = [];
        this.healthPacks = [];
        this.map = this.generateMap();
        this.status = 'waiting';
        this.killScores = new Map();
        this.startTime = null;
        this.tickInterval = null;
        this.isPrivateRoom = isPrivateRoom;
    }

    generateMap() {
        const width = 2000;
        const height = 1500;
        const walls = [];
        const obstacles = [];
        const spawnPoints = [];

        // Theme for rendering
        const theme = {
            bgColor: '#1a1a2e',
            wallColor: '#4a4a6a',
            accentColor: '#ff6b35'
        };

        for (let i = 0; i < 8; i++) {
            walls.push({
                x: 100 + Math.random() * (width - 300),
                y: 100 + Math.random() * (height - 300),
                w: 100 + Math.random() * 200,
                h: 20 + Math.random() * 30
            });
        }

        for (let i = 0; i < 5; i++) {
            obstacles.push({
                x: 100 + Math.random() * (width - 200),
                y: 100 + Math.random() * (height - 200),
                radius: 30 + Math.random() * 40
            });
        }

        for (let i = 0; i < 12; i++) {
            spawnPoints.push({
                x: 100 + Math.random() * (width - 200),
                y: 100 + Math.random() * (height - 200)
            });
        }

        this.healthPacks = [
            { x: width * 0.25, y: height * 0.5, active: true, respawnTime: 0 },
            { x: width * 0.75, y: height * 0.5, active: true, respawnTime: 0 }
        ];

        return { width, height, walls, obstacles, spawnPoints, theme, healthPacks: this.healthPacks };
    }

    addPlayer(playerId, playerData) {
        const spawnPoint = this.map.spawnPoints[this.players.size % this.map.spawnPoints.length];
        const hero = HEROES.find(h => h.id === playerData.heroId) || HEROES[0];

        this.players.set(playerId, {
            id: playerId,
            username: playerData.username,
            heroId: playerData.heroId,
            x: spawnPoint.x,
            y: spawnPoint.y,
            health: hero.health,
            maxHealth: hero.health,
            speed: hero.speed,
            attackDamage: hero.attackDamage,
            direction: { x: 1, y: 0 },
            isBot: false,
            ws: playerData.ws,
            kills: 0,
            deaths: 0
        });

        this.killScores.set(playerId, 0);
    }

    addBot(skillLevel) {
        const botId = 'bot_' + uuidv4().slice(0, 8);
        const spawnPoint = this.map.spawnPoints[(this.players.size + this.bots.size) % this.map.spawnPoints.length];
        const hero = HEROES[Math.floor(Math.random() * HEROES.length)];
        const botNames = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'];

        this.bots.set(botId, {
            id: botId,
            username: `Bot ${botNames[this.bots.size % botNames.length]}`,
            heroId: hero.id,
            x: spawnPoint.x,
            y: spawnPoint.y,
            health: hero.health,
            maxHealth: hero.health,
            speed: hero.speed * (0.8 + (skillLevel / 2000) * 0.4),
            attackDamage: hero.attackDamage,
            direction: { x: 1, y: 0 },
            isBot: true,
            skillLevel: skillLevel,
            actionTimer: 0,
            kills: 0,
            deaths: 0
        });

        this.killScores.set(botId, 0);
    }

    start() {
        this.status = 'playing';
        this.startTime = Date.now();

        // Only add bots for non-private rooms (matchmaking, quick play)
        if (!this.isPrivateRoom) {
            const totalPlayers = this.players.size + this.bots.size;
            for (let i = totalPlayers; i < PLAYERS_PER_MATCH; i++) {
                this.addBot(1000);
            }
        }

        this.tickInterval = setInterval(() => this.tick(), 1000 / TICK_RATE);
        this.broadcastGameState();
    }

    tick() {
        if (this.status !== 'playing') return;
        const deltaTime = 1000 / TICK_RATE;

        this.updateBots(deltaTime);
        this.updateProjectiles(deltaTime);
        this.updateHealthPacks(deltaTime);
        this.checkWinCondition();

        if (Date.now() % 50 < 17) {
            this.broadcastGameState();
        }
    }

    updateBots(deltaTime) {
        this.bots.forEach(bot => {
            bot.actionTimer -= deltaTime;
            if (bot.actionTimer <= 0) {
                bot.actionTimer = 500 + Math.random() * 1000;

                let nearestDist = Infinity;
                let nearestTarget = null;

                const allEntities = [...this.players.values(), ...this.bots.values()];
                allEntities.forEach(entity => {
                    if (entity.id !== bot.id && entity.health > 0) {
                        const dist = Math.hypot(entity.x - bot.x, entity.y - bot.y);
                        if (dist < nearestDist) {
                            nearestDist = dist;
                            nearestTarget = entity;
                        }
                    }
                });

                if (nearestTarget) {
                    const dx = nearestTarget.x - bot.x;
                    const dy = nearestTarget.y - bot.y;
                    const dist = Math.hypot(dx, dy);
                    if (dist > 0) {
                        bot.direction = { x: dx / dist, y: dy / dist };
                    }

                    if (nearestDist > 300) {
                        bot.x += bot.direction.x * bot.speed;
                        bot.y += bot.direction.y * bot.speed;
                    }

                    if (nearestDist < 500 && Math.random() < 0.3) {
                        this.createProjectile(bot, bot.direction);
                    }
                }

                bot.x = Math.max(20, Math.min(this.map.width - 20, bot.x));
                bot.y = Math.max(20, Math.min(this.map.height - 20, bot.y));
            }
        });
    }

    updateProjectiles(deltaTime) {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const proj = this.projectiles[i];
            proj.x += proj.velocityX * (deltaTime / 1000) * 60;
            proj.y += proj.velocityY * (deltaTime / 1000) * 60;
            proj.life -= deltaTime;

            if (proj.life <= 0 || proj.x < 0 || proj.x > this.map.width || proj.y < 0 || proj.y > this.map.height) {
                this.projectiles.splice(i, 1);
                continue;
            }

            const allEntities = [...this.players.values(), ...this.bots.values()];
            for (const entity of allEntities) {
                if (entity.id !== proj.ownerId && entity.health > 0) {
                    const dist = Math.hypot(entity.x - proj.x, entity.y - proj.y);
                    if (dist < 25) {
                        entity.health -= proj.damage;
                        this.projectiles.splice(i, 1);
                        if (entity.health <= 0) {
                            this.handleKill(proj.ownerId, entity.id);
                        }
                        break;
                    }
                }
            }
        }
    }

    updateHealthPacks(deltaTime) {
        this.healthPacks.forEach(pack => {
            if (!pack.active) {
                pack.respawnTime -= deltaTime;
                if (pack.respawnTime <= 0) pack.active = true;
            } else {
                const allEntities = [...this.players.values(), ...this.bots.values()];
                for (const entity of allEntities) {
                    if (entity.health > 0 && entity.health < entity.maxHealth) {
                        const dist = Math.hypot(entity.x - pack.x, entity.y - pack.y);
                        if (dist < 40) {
                            entity.health = Math.min(entity.maxHealth, entity.health + 50);
                            pack.active = false;
                            pack.respawnTime = 30000;
                            break;
                        }
                    }
                }
            }
        });
    }

    createProjectile(owner, direction) {
        this.projectiles.push({
            id: uuidv4(),
            ownerId: owner.id,
            x: owner.x,
            y: owner.y,
            velocityX: direction.x * 15,
            velocityY: direction.y * 15,
            damage: owner.attackDamage,
            life: 2000,
            heroId: owner.heroId
        });
    }

    handleKill(killerId, victimId) {
        const killer = this.players.get(killerId) || this.bots.get(killerId);
        const victim = this.players.get(victimId) || this.bots.get(victimId);

        if (killer) {
            killer.kills++;
            this.killScores.set(killerId, (this.killScores.get(killerId) || 0) + 1);
        }

        if (victim) {
            victim.deaths++;
            setTimeout(() => {
                if (this.status === 'playing') {
                    const spawnPoint = this.map.spawnPoints[Math.floor(Math.random() * this.map.spawnPoints.length)];
                    victim.x = spawnPoint.x;
                    victim.y = spawnPoint.y;
                    victim.health = victim.maxHealth;
                }
            }, 3000);
        }

        broadcast(this.id, {
            type: 'kill',
            killerName: killer ? killer.username : 'Unknown',
            victimName: victim ? victim.username : 'Unknown'
        });
    }

    checkWinCondition() {
        for (const [playerId, kills] of this.killScores) {
            if (kills >= KILLS_TO_WIN) {
                this.endGame(playerId);
                return;
            }
        }
    }

    endGame(winnerId) {
        this.status = 'ended';
        if (this.tickInterval) clearInterval(this.tickInterval);

        const winner = this.players.get(winnerId) || this.bots.get(winnerId);

        broadcast(this.id, {
            type: 'gameEnd',
            winnerId: winnerId,
            winnerName: winner ? winner.username : 'Bot',
            finalScores: Object.fromEntries(this.killScores)
        });

        setTimeout(() => games.delete(this.id), 30000);
    }

    handlePlayerInput(playerId, input) {
        const player = this.players.get(playerId);
        if (!player || player.health <= 0 || this.status !== 'playing') return;

        if (input.movement) {
            player.x += input.movement.x * player.speed;
            player.y += input.movement.y * player.speed;
            player.x = Math.max(20, Math.min(this.map.width - 20, player.x));
            player.y = Math.max(20, Math.min(this.map.height - 20, player.y));
        }

        if (input.direction) {
            player.direction = input.direction;
        }

        if (input.shoot) {
            this.createProjectile(player, player.direction);
        }
    }

    broadcastGameState() {
        broadcast(this.id, {
            type: 'gameState',
            players: Array.from(this.players.values()).map(p => ({
                id: p.id, username: p.username, heroId: p.heroId,
                x: p.x, y: p.y, health: p.health, maxHealth: p.maxHealth,
                direction: p.direction, kills: p.kills, deaths: p.deaths, isBot: false
            })),
            bots: Array.from(this.bots.values()).map(b => ({
                id: b.id, username: b.username, heroId: b.heroId,
                x: b.x, y: b.y, health: b.health, maxHealth: b.maxHealth,
                direction: b.direction, kills: b.kills, deaths: b.deaths, isBot: true
            })),
            projectiles: this.projectiles.map(p => ({ id: p.id, x: p.x, y: p.y, heroId: p.heroId })),
            healthPacks: this.healthPacks,
            killScores: Object.fromEntries(this.killScores)
        });
    }

    removePlayer(playerId) {
        this.players.delete(playerId);
        this.killScores.delete(playerId);
        if (this.players.size === 0 && this.status === 'playing') {
            this.endGame(null);
        }
    }
}

// Matchmaking
setInterval(() => {
    while (matchmakingQueue.length >= 2) {
        const gameId = 'game_' + uuidv4().slice(0, 8);
        const game = new GameState(gameId);
        games.set(gameId, game);

        const playersToAdd = Math.min(matchmakingQueue.length, PLAYERS_PER_MATCH);
        for (let i = 0; i < playersToAdd; i++) {
            const entry = matchmakingQueue.shift();
            const player = players.get(entry.playerId);
            if (player && player.ws.readyState === WebSocket.OPEN) {
                game.addPlayer(entry.playerId, { username: player.username, heroId: player.heroId, ws: player.ws });
                player.status = 'in-game';
                player.currentGame = gameId;
                sendToPlayer(entry.playerId, { type: 'matchFound', gameId: gameId, map: game.map });
            }
        }

        setTimeout(() => { if (games.has(gameId)) game.start(); }, 3000);
    }

    matchmakingQueue.forEach((entry, index) => {
        if (Date.now() - entry.joinTime > 10000 && matchmakingQueue.length >= 1) {
            const gameId = 'game_' + uuidv4().slice(0, 8);
            const game = new GameState(gameId);
            games.set(gameId, game);
            matchmakingQueue.splice(index, 1);

            const player = players.get(entry.playerId);
            if (player && player.ws.readyState === WebSocket.OPEN) {
                game.addPlayer(entry.playerId, { username: player.username, heroId: player.heroId, ws: player.ws });
                player.status = 'in-game';
                player.currentGame = gameId;
                sendToPlayer(entry.playerId, { type: 'matchFound', gameId: gameId, map: game.map });
                setTimeout(() => { if (games.has(gameId)) game.start(); }, 1000);
            }
        }
    });
}, 2000);

// WebSocket Handler
wss.on('connection', (ws) => {
    const playerId = uuidv4();
    console.log(`Player connected: ${playerId}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(playerId, ws, data);
        } catch (e) {
            console.error('Parse error:', e);
        }
    });

    ws.on('close', () => handleDisconnect(playerId));
    ws.send(JSON.stringify({ type: 'connected', playerId }));
});

function handleMessage(playerId, ws, data) {
    switch (data.type) {
        case 'guestLogin':
            const guestName = data.username || `Guest_${playerId.slice(0, 6)}`;
            const guestCode = generateFriendCode();
            players.set(playerId, { ws, username: guestName, status: 'online', currentGame: null, heroId: 'blaze', friendCode: guestCode });
            accounts.set(guestCode, { username: guestName, playerData: { currency: 500, ownedSkins: {}, equippedSkins: {}, stats: { totalKills: 0, totalDeaths: 0, matchesPlayed: 0, wins: 0 }, friends: [] } });
            ws.send(JSON.stringify({ type: 'loginResult', success: true, playerId, friendCode: guestCode, playerData: accounts.get(guestCode).playerData }));
            break;

        case 'register':
            // Check if username exists
            let exists = false;
            for (const [code, acc] of accounts) {
                if (acc.username && acc.username.toLowerCase() === data.username.toLowerCase()) {
                    exists = true;
                    break;
                }
            }
            if (exists) {
                ws.send(JSON.stringify({ type: 'registerResult', success: false, error: 'Username already exists' }));
                break;
            }
            const newCode = generateFriendCode();
            const newPlayerData = { username: data.username, currency: 500, ownedSkins: {}, equippedSkins: {}, stats: { totalKills: 0, totalDeaths: 0, matchesPlayed: 0, wins: 0 }, friends: [] };
            accounts.set(newCode, { username: data.username, password: data.password, playerData: newPlayerData });
            players.set(playerId, { ws, username: data.username, status: 'online', currentGame: null, heroId: 'blaze', friendCode: newCode });
            ws.send(JSON.stringify({ type: 'registerResult', success: true, playerId, friendCode: newCode, username: data.username, playerData: newPlayerData }));
            break;

        case 'login':
            let found = null;
            let foundCode = null;
            for (const [code, acc] of accounts) {
                if (acc.username && acc.username.toLowerCase() === data.username.toLowerCase() && acc.password === data.password) {
                    found = acc;
                    foundCode = code;
                    break;
                }
            }
            if (!found) {
                ws.send(JSON.stringify({ type: 'loginResult', success: false, error: 'Invalid username or password' }));
                break;
            }
            players.set(playerId, { ws, username: found.username, status: 'online', currentGame: null, heroId: 'blaze', friendCode: foundCode });
            ws.send(JSON.stringify({ type: 'loginResult', success: true, playerId, friendCode: foundCode, username: found.username, playerData: found.playerData }));
            break;

        case 'joinMatchmaking':
            const p1 = players.get(playerId);
            if (p1) {
                if (data.heroId) p1.heroId = data.heroId;
                matchmakingQueue.push({ playerId, heroId: p1.heroId, joinTime: Date.now() });
                p1.status = 'matchmaking';
                sendToPlayer(playerId, { type: 'matchmakingStatus', status: 'searching', playersInQueue: matchmakingQueue.length });
            }
            break;

        case 'quickPlay':
            const p2 = players.get(playerId);
            if (p2) {
                if (data.heroId) p2.heroId = data.heroId;
                const gameId = 'game_' + uuidv4().slice(0, 8);
                const game = new GameState(gameId);
                games.set(gameId, game);
                game.addPlayer(playerId, { username: p2.username, heroId: p2.heroId, ws: p2.ws });
                p2.status = 'in-game';
                p2.currentGame = gameId;
                sendToPlayer(playerId, { type: 'matchFound', gameId, map: game.map });
                setTimeout(() => { if (games.has(gameId)) game.start(); }, 1000);
            }
            break;

        case 'createRoom':
            const p3 = players.get(playerId);
            if (p3) {
                let roomCode = generateRoomCode();
                while (privateRooms.has(roomCode)) roomCode = generateRoomCode();
                privateRooms.set(roomCode, { hostId: playerId, players: [{ id: playerId, username: p3.username, heroId: data.heroId || 'blaze' }], status: 'waiting' });
                p3.heroId = data.heroId || 'blaze';
                p3.status = 'in-room';
                p3.currentRoom = roomCode;
                sendToPlayer(playerId, { type: 'roomCreated', roomCode });
                console.log(`Room created: ${roomCode}`);
            }
            break;

        case 'joinRoom':
            const p4 = players.get(playerId);
            const roomCode = data.roomCode?.toUpperCase();
            const room = privateRooms.get(roomCode);
            if (!room) { sendToPlayer(playerId, { type: 'roomError', error: 'Room not found' }); break; }
            if (room.status !== 'waiting') { sendToPlayer(playerId, { type: 'roomError', error: 'Game in progress' }); break; }
            if (room.players.length >= 10) { sendToPlayer(playerId, { type: 'roomError', error: 'Room full' }); break; }
            room.players.push({ id: playerId, username: p4.username, heroId: data.heroId || 'blaze' });
            p4.heroId = data.heroId || 'blaze';
            p4.status = 'in-room';
            p4.currentRoom = roomCode;
            sendToPlayer(playerId, { type: 'roomJoined', roomCode });
            broadcastToRoom(roomCode, { type: 'roomUpdate', players: room.players });
            break;

        case 'startRoom':
            const rm = privateRooms.get(data.roomCode);
            if (!rm || rm.hostId !== playerId) break;
            rm.status = 'starting';
            const gId = 'room_' + data.roomCode;
            const gm = new GameState(gId, true); // true = private room, no bots
            games.set(gId, gm);
            rm.players.forEach(rp => {
                const pl = players.get(rp.id);
                if (pl && pl.ws.readyState === WebSocket.OPEN) {
                    gm.addPlayer(rp.id, { username: rp.username, heroId: rp.heroId, ws: pl.ws });
                    pl.status = 'in-game';
                    pl.currentGame = gId;
                    pl.currentRoom = null;
                }
            });
            broadcastToRoom(data.roomCode, { type: 'matchFound', gameId: gId, map: gm.map });
            setTimeout(() => { if (games.has(gId)) gm.start(); }, 1000);
            privateRooms.delete(data.roomCode);
            break;

        case 'gameInput':
            const p6 = players.get(playerId);
            if (p6 && p6.currentGame) {
                const game = games.get(p6.currentGame);
                if (game) game.handlePlayerInput(playerId, data.input);
            }
            break;

        case 'leaveGame':
            const p7 = players.get(playerId);
            if (p7 && p7.currentGame) {
                const game = games.get(p7.currentGame);
                if (game) game.removePlayer(playerId);
                p7.currentGame = null;
                p7.status = 'online';
                sendToPlayer(playerId, { type: 'leftGame' });
            }
            break;
    }
}

function handleDisconnect(playerId) {
    const player = players.get(playerId);
    if (player) {
        const qi = matchmakingQueue.findIndex(e => e.playerId === playerId);
        if (qi !== -1) matchmakingQueue.splice(qi, 1);

        if (player.currentRoom) {
            const room = privateRooms.get(player.currentRoom);
            if (room) {
                room.players = room.players.filter(p => p.id !== playerId);
                if (room.players.length === 0 || room.hostId === playerId) {
                    privateRooms.delete(player.currentRoom);
                } else {
                    broadcastToRoom(player.currentRoom, { type: 'roomUpdate', players: room.players });
                }
            }
        }

        if (player.currentGame) {
            const game = games.get(player.currentGame);
            if (game) game.removePlayer(playerId);
        }
    }
    players.delete(playerId);
    console.log(`Player disconnected: ${playerId}`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n=== IconX Server running on port ${PORT} ===`);
    console.log(`Open http://localhost:${PORT} in your browser\n`);
});
