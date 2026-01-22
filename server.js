const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static('public'));

let rooms = {};

// CONFIG
const VIRTUAL_WIDTH = 400;  // The game always thinks it's this wide
const VIRTUAL_HEIGHT = 800; // And this tall

// GRID BASED MAP GENERATOR
function generateMap(round) {
    const cols = 10;
    const rows = 20;
    const cellW = VIRTUAL_WIDTH / cols;
    const cellH = VIRTUAL_HEIGHT / rows;
    
    let walls = [];
    
    // 1. Add Borders
    walls.push({x: 0, y: 0, w: VIRTUAL_WIDTH, h: 20}); // Top
    walls.push({x: 0, y: VIRTUAL_HEIGHT-20, w: VIRTUAL_WIDTH, h: 20}); // Bottom
    walls.push({x: 0, y: 0, w: 20, h: VIRTUAL_HEIGHT}); // Left
    walls.push({x: VIRTUAL_WIDTH-20, y: 0, w: 20, h: VIRTUAL_HEIGHT}); // Right

    // 2. Generate Random Obstacles (Rows)
    // We skip top 3 rows (hole) and bottom 3 rows (start)
    for(let r = 3; r < rows - 3; r++) {
        // Randomly decide to place a wall pattern in this row
        let pattern = Math.floor(Math.random() * 4); // 0=None, 1=Left, 2=Right, 3=Center
        
        // Increase difficulty: Higher rounds = more complex patterns
        if(round > 2 && Math.random() > 0.5) pattern = Math.floor(Math.random() * 5);

        if(pattern === 1) { // Left Wall
            walls.push({ x: 0, y: r*cellH, w: VIRTUAL_WIDTH * 0.4, h: 20 });
        } else if (pattern === 2) { // Right Wall
            walls.push({ x: VIRTUAL_WIDTH * 0.6, y: r*cellH, w: VIRTUAL_WIDTH * 0.4, h: 20 });
        } else if (pattern === 3) { // Center Block
            walls.push({ x: VIRTUAL_WIDTH * 0.3, y: r*cellH, w: VIRTUAL_WIDTH * 0.4, h: 20 });
        } else if (pattern === 4) { // Split (Hard)
            walls.push({ x: 0, y: r*cellH, w: VIRTUAL_WIDTH * 0.3, h: 20 });
            walls.push({ x: VIRTUAL_WIDTH * 0.7, y: r*cellH, w: VIRTUAL_WIDTH * 0.3, h: 20 });
        }
    }

    return {
        hole: { x: VIRTUAL_WIDTH/2, y: 80, radius: 18 },
        start: { x: VIRTUAL_WIDTH/2, y: VIRTUAL_HEIGHT - 100 },
        walls: walls,
        round: round,
        par: 3 + Math.floor(round/2)
    };
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substring(7).toUpperCase();
        rooms[roomId] = {
            id: roomId,
            players: [], // Array for turn order
            config: { maxPlayers: parseInt(data.maxPlayers) },
            state: 'waiting', 
            turnIndex: 0,
            map: null
        };
        socket.emit('room_created', roomId);
    });

    socket.on('join_room', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length < room.config.maxPlayers && room.state === 'waiting') {
            
            const newPlayer = {
                id: socket.id,
                name: data.name,
                color: ['#e74c3c', '#3498db', '#f1c40f', '#9b59b6'][room.players.length], // Red, Blue, Yellow, Purple
                x: 0, y: 0,
                score: 0,
                finished: false
            };
            
            room.players.push(newPlayer);
            socket.join(data.roomId);
            io.to(data.roomId).emit('update_lobby', room.players);

            // Start Game
            if (room.players.length === room.config.maxPlayers) {
                room.state = 'playing';
                room.map = generateMap(1);
                room.turnIndex = 0;
                
                // Set start positions
                room.players.forEach(p => {
                    p.x = room.map.start.x;
                    p.y = room.map.start.y;
                    p.finished = false;
                });

                io.to(data.roomId).emit('game_start', { 
                    map: room.map, 
                    players: room.players,
                    turnId: room.players[0].id
                });
            }
        }
    });

    // Handle Shot
    socket.on('shoot', (data) => {
        const room = rooms[data.roomId];
        if(!room) return;
        
        // Verify it is this player's turn
        const currentPlayer = room.players[room.turnIndex];
        if(currentPlayer.id !== socket.id) return; // Ignore if not your turn

        // Broadcast the shot to everyone (Client calculates physics)
        io.to(data.roomId).emit('player_shot', { 
            id: socket.id, 
            vx: data.vx, 
            vy: data.vy 
        });
    });

    // Player Turn Ended (Ball stopped)
    socket.on('turn_complete', (data) => {
        const room = rooms[data.roomId];
        if(!room) return;

        // Update position on server
        const p = room.players.find(pl => pl.id === socket.id);
        if(p) {
            p.x = data.x;
            p.y = data.y;
        }

        // Logic to find next player
        let originalTurn = room.turnIndex;
        let loopCount = 0;
        
        do {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            loopCount++;
        } while (room.players[room.turnIndex].finished && loopCount < room.players.length);

        // Check if Round Over (Everyone finished)
        const allFinished = room.players.every(p => p.finished);

        if (allFinished) {
            // Next Round Logic
            room.players.forEach(p => p.finished = false); // Reset status
            room.map = generateMap(room.map.round + 1);
            room.turnIndex = 0;
            
            room.players.forEach(p => {
                p.x = room.map.start.x;
                p.y = room.map.start.y;
            });

            io.to(data.roomId).emit('next_round', {
                map: room.map,
                players: room.players,
                turnId: room.players[0].id
            });

        } else {
            // Next Turn
            io.to(data.roomId).emit('change_turn', {
                turnId: room.players[room.turnIndex].id,
                players: room.players // Sync positions
            });
        }
    });

    socket.on('hole_in', (data) => {
        const room = rooms[data.roomId];
        const p = room.players.find(pl => pl.id === socket.id);
        if(p) {
            p.finished = true;
            p.score += 1; // You could add complex scoring here
            io.to(data.roomId).emit('msg', `${p.name} finished!`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Running on ${PORT}`); });
                
