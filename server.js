const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(express.static('public'));

let rooms = {};

// Helper: Generate Random Map
function generateMap(round) {
    let obstacles = [];
    // Increase difficulty: More obstacles each round
    let count = round * 2; 
    
    for(let i=0; i<count; i++) {
        obstacles.push({
            x: Math.random() * 300 + 50, // Keep away from walls
            y: Math.random() * 400 + 100, // Keep away from start/end areas
            w: Math.random() * 50 + 20,
            h: Math.random() * 50 + 20
        });
    }
    
    return {
        hole: { x: 200, y: 50, radius: 15 }, // Hole at top
        start: { x: 200, y: 700 },          // Start at bottom
        obstacles: obstacles,
        maxShots: 3 + round,                // More shots for harder maps
        round: round
    };
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create Room
    socket.on('create_room', (data) => {
        const roomId = Math.random().toString(36).substring(7).toUpperCase();
        rooms[roomId] = {
            id: roomId,
            players: {},
            config: { maxPlayers: parseInt(data.maxPlayers) },
            state: 'waiting', // waiting, playing, finished
            currentRound: 1,
            map: null
        };
        socket.emit('room_created', roomId);
    });

    // Join Room
    socket.on('join_room', (data) => {
        const room = rooms[data.roomId];
        if (room && Object.keys(room.players).length < room.config.maxPlayers && room.state === 'waiting') {
            room.players[socket.id] = {
                id: socket.id,
                name: data.name,
                shots: 0,
                totalScore: 0,
                x: 0, y: 0, // Will be set by map
                vx: 0, vy: 0,
                inHole: false,
                color: '#' + Math.floor(Math.random()*16777215).toString(16) // Random color
            };
            socket.join(data.roomId);
            
            // Notify everyone in room
            io.to(data.roomId).emit('update_players', room.players);

            // Start Game if full
            if (Object.keys(room.players).length === room.config.maxPlayers) {
                room.state = 'playing';
                room.map = generateMap(1);
                // Reset positions
                for(let pid in room.players) {
                    room.players[pid].x = room.map.start.x;
                    room.players[pid].y = room.map.start.y;
                    room.players[pid].inHole = false;
                    room.players[pid].shots = 0;
                }
                io.to(data.roomId).emit('game_start', { map: room.map, players: room.players });
            }
        } else {
            socket.emit('error', 'Room full or does not exist');
        }
    });

    // Handle Player Move (Shot)
    socket.on('shoot', (data) => {
        // Broadcast force to others so they see animation
        // In a real game, physics should be server-side to prevent cheating
        // For simplicity, we trust the client here
        socket.to(data.roomId).emit('player_shot', { id: socket.id, vx: data.vx, vy: data.vy });
    });

    // Player finished hole
    socket.on('hole_in', (data) => {
        const room = rooms[data.roomId];
        if(!room) return;
        
        let player = room.players[socket.id];
        player.inHole = true;
        player.shots = data.shots;
        player.totalScore += data.shots;
        
        io.to(data.roomId).emit('player_finished', { id: socket.id, shots: data.shots });

        // Check if round over
        const allFinished = Object.values(room.players).every(p => p.inHole || p.shots >= room.map.maxShots);
        
        if (allFinished) {
            if(room.currentRound >= 5) {
                io.to(data.roomId).emit('game_over', room.players);
            } else {
                room.currentRound++;
                room.map = generateMap(room.currentRound);
                // Reset for next round
                for(let pid in room.players) {
                    room.players[pid].inHole = false;
                    room.players[pid].shots = 0;
                    room.players[pid].x = room.map.start.x;
                    room.players[pid].y = room.map.start.y;
                }
                setTimeout(() => {
                    io.to(data.roomId).emit('next_round', { map: room.map, players: room.players });
                }, 3000); // 3 sec delay
            }
        }
    });
    
    // Sync Position (Keep everyone updated)
    socket.on('sync_pos', (data) => {
       socket.to(data.roomId).emit('update_pos', { id: socket.id, x: data.x, y: data.y }); 
    });
});

server.listen(3000, () => {
  console.log('Server running on *:3000');
});
