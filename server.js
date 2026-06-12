const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Cấu hình để phục vụ file giao diện index.html
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Lưu trữ trạng thái game trong bộ nhớ
let players = {}; 
let gameStatus = "LOBBY"; 
let currentQuestion = null;
let fastAnswers = []; 

io.on('connection', (socket) => {
    console.log(`Người chơi kết nối: ${socket.id}`);

    // 1. Người chơi đăng nhập vào phòng chờ
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

    // 2. QUẢN TRÒ BẮT ĐẦU GAME
    socket.on('start_game', () => {
        const playerIds = Object.keys(players);
        if (playerIds.length < 3) { 
            socket.emit('error', 'Không đủ người chơi để bắt đầu (Cần tối thiểu 3 người)!');
            return;
        }

        gameStatus = "PLAYING";
        const shuffledIds = playerIds.sort(() => 0.5 - Math.random());
        
        // Chỉ định tối đa 3 sát thủ dựa trên số lượng người chơi
        const numAssassins = Math.min(3, Math.max(1, Math.floor(playerIds.length * 0.15)));
        
        shuffledIds.forEach((id, index) => {
            if (index < numAssassins) {
                players[id].role = "ASSASSIN";
            } else {
                players[id].role = "POLICE";
            }
        });

        shuffledIds.forEach(id => {
            io.to(id).emit('receive_role', { role: players[id].role });
        });

        io.emit('game_status_changed', gameStatus);
    });

    // 3. SÁT THỦ CẬP NHẬT MANH MỐI
    socket.on('submit_clue', (clueText) => {
        if (players[socket.id] && players[socket.id].role === "ASSASSIN") {
            players[socket.id].clue = clueText;
            socket.emit('clue_saved', true);
        }
    });

    // 4. LUỒNG ÁM SÁT
    socket.on('assassinate_player', (targetId) => {
        const killer = players[socket.id];
        const victim = players[targetId];

        if (killer && killer.role === "ASSASSIN" && victim && victim.isAlive) {
            victim.isAlive = false;
            killer.stolenVotes += 1;

            io.to(targetId).emit('you_are_dead');
            io.emit('player_died', { 
                victimName: victim.name, 
                updatedPlayers: Object.values(players) 
            });
        }
    });

    // 5. MINI-GAME TỐC CHIẾN
    socket.on('host_trigger_minigame', (questionData) => {
        currentQuestion = questionData;
        fastAnswers = []; 
        io.emit('receive_minigame_question', {
            id: currentQuestion.id,
            question: currentQuestion.question
        });
    });

    socket.on('submit_minigame_answer', (userAnswer) => {
        if (!currentQuestion) return;
        if (fastAnswers.length >= 3) return;

        const alreadyAnswered = fastAnswers.some(ans => ans.socketId === socket.id);
        if (alreadyAnswered) return;

        const isCorrect = userAnswer.trim().toLowerCase() === currentQuestion.correctAnswer.trim().toLowerCase();

        if (isCorrect) {
            fastAnswers.push({
                socketId: socket.id,
                name: players[socket.id]?.name,
                role: players[socket.id]?.role
            });

            if (fastAnswers.length === 3 || fastAnswers.length === Object.keys(players).filter(id => players[id].isAlive).length) {
                processMiniGameRewards(fastAnswers);
                currentQuestion = null;
            }
        }
    });

    function processMiniGameRewards(winners) {
        winners.forEach((winner) => {
            const playerSocketId = winner.socketId;
            const playerRole = winner.role;

            if (playerRole === "POLICE") {
                const assassins = Object.values(players).filter(p => p.role === "ASSASSIN" && p.isAlive);
                if (assassins.length > 0) {
                    const randomAssassin = assassins[Math.floor(Math.random() * assassins.length)];
                    io.to(playerSocketId).emit('receive_reward', {
                        type: "CLUE",
                        message: `GỢI Ý MẬT: Một trong các Sát thủ có đặc điểm: "${randomAssassin.clue}"`
                    });
                }
            } else if (playerRole === "ASSASSIN") {
                io.to(playerSocketId).emit('receive_reward', {
                    type: "KILL_SKILL",
                    message: "BẠN NHẬN ĐƯỢC 1 ĐẠN ÁM SÁT! Hãy đi cụng ly hoặc hô bia với 1 mục tiêu, sau đó chọn tên họ trên điện thoại để hạ sát."
                });
            }
        });
        io.emit('minigame_ended', winners.map(w => w.name));
    }

    // 6. LUỒNG BÌNH CHỌN (VOTE TOP 5)
    socket.on('submit_votes_round', (votesArray) => {
        let voteCounts = {};
        votesArray.forEach(v => {
            voteCounts[v.targetId] = (voteCounts[v.targetId] || 0) + v.votes;
        });

        let top5 = Object.keys(voteCounts)
            .sort((a, b) => voteCounts[b] - voteCounts[a])
            .slice(0, 5);

        let hasAssassin = top5.some(id => players[id] && players[id].role === "ASSASSIN");

        io.emit('vote_result_announced', {
            hasAssassin: hasAssassin,
            top5Names: top5.map(id => players[id]?.name)
        });
    });

    // 7. LUỒNG VÒNG CHỐT HẠ KHẢO SÁT CHUNG CUỘC
    socket.on('submit_final_votes', (allVotesArray) => {
        gameStatus = "FINAL_VOTE";
        let finalVoteCounts = {};
        
        allVotesArray.forEach(v => {
            finalVoteCounts[v.targetId] = (finalVoteCounts[v.targetId] || 0) + v.votesCount;
        });

        let sortedFinalists = Object.keys(finalVoteCounts).sort((a, b) => finalVoteCounts[b] - finalVoteCounts[a]);
        let top3Executed = sortedFinalists.slice(0, 3);

        let caughtAssassinsCount = 0;
        top3Executed.forEach(id => {
            if (players[id] && players[id].role === "ASSASSIN") {
                caughtAssassinsCount++;
            }
        });

        let gameWinner = "ASSASSINS";
        if (caughtAssassinsCount >= 2) {
            gameWinner = "POLICE";
        }

        io.emit('game_over_announced', {
            winnerPhe: gameWinner,
            caughtCount: caughtAssassinsCount,
            allAssassins: Object.values(players)
                .filter(p => p.role === "ASSASSIN")
                .map(p => ({ name: p.name, isAlive: p.isAlive }))
        });
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update_player_list', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server game dang chay tai port ${PORT}`);
});
