const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static('public'));

let rooms = {};

const VW = 400;  
const VH = 800; 

// --- NEW MAP GENERATOR ---
function generateMap(round) {
    let walls = [];
    
    // 1. Determine Difficulty
    // Round 1 = Obstacles every 200px (Easy)
    // Round 5 = Obstacles every 120px (Hard)
    let spacing = Math.max(120, 220 - (round * 20)); 
    
    // 2. Borders (Keep ball inside)
    walls.push({x: 0, y: 0, w: VW, h: 20}); // Top
    walls.push({x: 0, y: VH-20, w: VW, h: 20}); // Bottom
    walls.push({x: 0, y: 0, w: 20, h: VH}); // Left
    walls.push({x: VW-20, y: 0, w: 20, h: VH}); // Right

    // 3. Generate Obstacles
    // Start from y=150 (below hole) to y=650 (above start)
    for(let y = 150; y < VH - 150; y += spacing) {
        
        // Random Pattern
        let type = Math.floor(Math.random() * 5);
        
        // Add some random offset so it doesn't look like a perfect grid
        let rY = y + (Math.random() * 40 - 20); 

        if (type === 0) { 
            // The "Gate" (Gap in middle)
            // Left block
            walls.push({ x: 0, y: rY, w: VW * 0.35, h: 30 });
            // Right block
            walls.push({ x: VW * 0.65, y: rY, w: VW * 0.35, h: 30 });
            
        } else if (type === 1) { 
            // The "Post" (One block in center)
            walls.push({ x: VW/2 - 60, y: rY, w: 120, h: 30 });
            
        } else if (type === 2) {
            // "The Split" (Gap on left and right)
            walls.push({ x: VW * 0.3, y: rY, w: VW * 0.4, h: 30 });
            
        } else if (type === 3) {
             // "Gnomes" (3 small squares)
             walls.push({ x: VW*0.2, y: rY, w: 40, h: 40 });
             walls.push({ x: VW*0.5 - 20, y: rY, w: 40, h: 40 });
             walls.push({ x: VW*0.8 - 40, y: rY, w: 40, h: 40 });
        }
        // Type 4 is an empty row (Free pass!)
    }

    return {
        hole: { x: VW/2, y: 80, radius: 18 },
        start: { x: VW/2, y: VH - 100 },
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
            players: [],
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
                color: ['#e74c3c', '#3498db', '#f1c40f', '#9b59b6'][room.players.length],
                x: 0, y: 0, score: 0, finished: false
            };
            
            room.players.push(newPlayer);
            socket.join(data.roomId);
            io.to(data.roomId).emit('update_lobby', room.players);

            if (room.players.length === room.config.maxPlayers) {
                room.state = 'playing';
                room.map = generateMap(1); // Start Round 1
                room.turnIndex = 0;
                
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

    socket.on('shoot', (data) => {
        const room = rooms[data.roomId];
        if(!room) return;
        io.to(data.roomId).emit('player_shot', { id: socket.id, vx: data.vx, vy: data.vy });
    });

    socket.on('turn_complete', (data) => {
        const room = rooms[data.roomId];
        if(!room) return;

        const p = room.players.find(pl => pl.id === socket.id);
        if(p) { p.x = data.x; p.y = data.y; }

        let loopCount = 0;
        do {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            loopCount++;
        } while (room.players[room.turnIndex].finished && loopCount < room.players.length);

        if (room.players.every(p => p.finished)) {
            // Next Round or Game Over
            if(room.map.round >= 5) {
                 io.to(data.roomId).emit('msg', "GAME OVER! Thanks for playing.");
            } else {
                room.players.forEach(p => p.finished = false);
                room.map = generateMap(room.map.round + 1);
                room.turnIndex = 0;
                room.players.forEach(p => { p.x = room.map.start.x; p.y = room.map.start.y; });
                
                io.to(data.roomId).emit('next_round', {
                    map: room.map,
                    players: room.players,
                    turnId: room.players[0].id
                });
            }
        } else {
            io.to(data.roomId).emit('change_turn', {
                turnId: room.players[room.turnIndex].id,
                players: room.players
            });
        }
    });

    socket.on('hole_in', (data) => {
        const room = rooms[data.roomId];
        const p = room.players.find(pl => pl.id === socket.id);
        if(p) { p.finished = true; p.score += 1; io.to(data.roomId).emit('msg', `${p.name} finished!`); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Running on ${PORT}`); });
