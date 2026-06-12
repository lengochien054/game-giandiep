const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

let players = {}; 
let gameStatus = "LOBBY"; 
let minigameTimeout = null;
let minigameActive = false;
let currentCorrectAnswer = "";
let minigameAnswers = []; 

io.on('connection', (socket) => {
    console.log(`Người chơi kết nối: ${socket.id}`);

    socket.on('join_game', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name,
            role: "PENDING",
            isAlive: true,
            stolenVotes: 0,
            clue: ""
        };
        io.emit('update_player_list', Object.values(players));
    });

    socket.on('kick_player_by_admin', (badPlayerSocketId) => {
        if (io.sockets.sockets.get(badPlayerSocketId)) {
            io.to(badPlayerSocketId).emit('kicked_by_admin');
            delete players[badPlayerSocketId];
            io.emit('update_player_list', Object.values(players));
        }
    });

    socket.on('start_game', () => {
        const playerIds = Object.keys(players);
        if (playerIds.length < 3) { 
            socket.emit('error', 'Không đủ người chơi (Cần tối thiểu 3 người)!');
            return;
        }

        gameStatus = "PLAYING";
        const shuffledIds = playerIds.sort(() => 0.5 - Math.random());
        const numAssassins = Math.min(3, Math.max(1, Math.floor(playerIds.length * 0.15)));
        
        shuffledIds.forEach((id, index) => {
            if (index < numAssassins) { players[id].role = "ASSASSIN"; } 
            else { players[id].role = "POLICE"; }
        });

        shuffledIds.forEach(id => { io.to(id).emit('receive_role', { role: players[id].role }); });
        io.emit('game_status_changed', gameStatus);
    });

    socket.on('submit_clue', (clueText) => {
        if (players[socket.id] && players[socket.id].role === "ASSASSIN") {
            players[socket.id].clue = clueText;
            socket.emit('clue_saved', true);
        }
    });

    socket.on('assassinate_player', (targetId) => {
        const killer = players[socket.id];
        const victim = players[targetId];

        if (killer && killer.role === "ASSASSIN" && victim && victim.isAlive) {
            victim.isAlive = false;
            killer.stolenVotes += 1;
            io.to(targetId).emit('you_are_dead');
            io.emit('player_died', { victimName: victim.name, updatedPlayers: Object.values(players) });
        }
    });

    socket.on('host_trigger_minigame', (data) => {
        if (minigameTimeout) clearTimeout(minigameTimeout);
        minigameActive = true;
        currentCorrectAnswer = data.correctAnswer.toUpperCase().trim();
        minigameAnswers = [];

        io.emit('receive_minigame_question', {
            type: data.type,
            question: data.question,
            options: data.options,
            duration: 60
        });

        minigameTimeout = setTimeout(() => { if (minigameActive) endMinigame(); }, 60000);
    });

    socket.on('submit_minigame_answer', (answerText) => {
        if (!minigameActive) return;
        const p = players[socket.id];
        if (!p || !p.isAlive) return;

        const isCorrect = answerText.toUpperCase().trim() === currentCorrectAnswer;
        if (!minigameAnswers.some(ans => ans.id === socket.id)) {
            minigameAnswers.push({ id: socket.id, name: p.name, isCorrect: isCorrect, time: Date.now() });
        }
    });

    function endMinigame() {
        minigameActive = false;
        if (minigameTimeout) clearTimeout(minigameTimeout);

        const correctAnswers = minigameAnswers.filter(ans => ans.isCorrect).sort((a, b) => a.time - b.time);
        const winners = correctAnswers.slice(0, 3).map(ans => ans.name);

        correctAnswers.slice(0, 3).forEach((ans, index) => {
            const targetSocket = io.sockets.sockets.get(ans.id);
            if (targetSocket) {
                if (players[ans.id].role === 'ASSASSIN') {
                    targetSocket.emit('receive_reward', { type: 'KILL_SKILL', message: `🏆 Top ${index+1}! Nhận 1 Kỹ năng Ám Sát sau khi cụng ly.` });
                } else {
                    targetSocket.emit('receive_reward', { type: 'CLUE', message: `🏆 Top ${index+1}! Hệ thống định vị: 1 Sát thủ có manh mối bí mật.` });
                }
            }
        });
        io.emit('minigame_ended', winners);
    }

    socket.on('submit_votes_round', (votesArray) => {
        let voteCounts = {};
        votesArray.forEach(v => { voteCounts[v.targetId] = (voteCounts[v.targetId] || 0) + v.votes; });
        let top5 = Object.keys(voteCounts).sort((a, b) => voteCounts[b] - voteCounts[a]).slice(0, 5);
        let hasAssassin = top5.some(id => players[id] && players[id].role === "ASSASSIN");
        io.emit('vote_result_announced', { hasAssassin: hasAssassin, top5Names: top5.map(id => players[id]?.name) });
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update_player_list', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server chạy tại port ${PORT}`); });
