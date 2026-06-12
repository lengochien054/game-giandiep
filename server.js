const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.resolve(__dirname)));

app.get('/', (req, res) => { res.sendFile(path.resolve(__dirname, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.resolve(__dirname, 'admin.html')); });

let players = {}; 
let assassinsConfig = []; 
let minigameTimeout = null;
let minigameActive = false;
let currentCorrectAnswer = "";
let minigameAnswers = []; 

let voteTimeout = null;
let voteActive = false;
let currentVotes = []; 

io.on('connection', (socket) => {
    console.log(`Kết nối: ${socket.id}`);
    socket.emit('update_player_list', Object.values(players));

    socket.on('join_game', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name,
            role: "PENDING",
            isAlive: true,
            stolenVotes: 0, 
            clue: "",
            correctAnswersCount: 0 
        };
        io.emit('update_player_list', Object.values(players));
    });

    socket.on('kick_player_by_admin', (badPlayerId) => {
        if (players[badPlayerId]) {
            io.to(badPlayerId).emit('kicked_by_admin');
            delete players[badPlayerId];
            io.emit('update_player_list', Object.values(players));
        }
    });

    socket.on('admin_assign_roles', (data) => {
        assassinsConfig = data.assassins.filter(as => as.id !== "");

        Object.keys(players).forEach(id => {
            players[id].role = "POLICE";
            players[id].clue = "";
            players[id].correctAnswersCount = 0;
            players[id].stolenVotes = 0;
        });

        data.assassins.forEach((as) => {
            if (as.id && players[as.id]) {
                players[as.id].role = "ASSASSIN";
                players[as.id].clue = as.clue;
            }
        });

        Object.keys(players).forEach(id => {
            if (players[id].role === "ASSASSIN") {
                io.to(id).emit('receive_role', { 
                    role: "ASSASSIN", 
                    message: `Bạn là sát thủ, hãy nhanh chóng bắn thật nhiều cảnh sát. Gợi ý về bạn là: ${players[id].clue}`
                });
            } else {
                io.to(id).emit('receive_role', { 
                    role: "POLICE", 
                    message: "Xin chào cảnh sát, hãy mau chóng tìm ra sát thủ trước khi bị loại"
                });
            }
        });

        io.emit('update_player_list', Object.values(players));
    });

    socket.on('assassinate_player', (targetId) => {
        const killer = players[socket.id];
        const victim = players[targetId];

        if (killer && killer.role === "ASSASSIN" && victim && victim.isAlive) {
            victim.isAlive = false;
            killer.stolenVotes += 1; 
            
            io.to(targetId).emit('you_are_dead');
            io.emit('player_died', { victimName: victim.name });
            io.emit('update_player_list', Object.values(players));
        }
    });

    socket.on('host_trigger_minigame', (data) => {
        if (minigameTimeout) clearTimeout(minigameTimeout);
        minigameActive = true;
        currentCorrectAnswer = data.correctAnswer.toUpperCase().trim();
        minigameAnswers = [];

        io.emit('close_all_overlays'); 
        
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
        socket.emit('minigame_feedback', { isCorrect: isCorrect });

        if (isCorrect && !minigameAnswers.some(ans => ans.id === socket.id)) {
            p.correctAnswersCount += 1; 
            minigameAnswers.push({ id: socket.id, name: p.name, time: Date.now() });

            if (p.role === 'POLICE') {
                let clueMessage = "";
                if (p.correctAnswersCount === 1 && assassinsConfig[0]) {
                    clueMessage = `Gợi ý về Sát thủ 1: "${assassinsConfig[0].clue}"`;
                } else if (p.correctAnswersCount === 2 && assassinsConfig[1]) {
                    clueMessage = `Gợi ý về Sát thủ 2: "${assassinsConfig[1].clue}"`;
                } else if (p.correctAnswersCount >= 3 && assassinsConfig[2]) {
                    clueMessage = `Gợi ý về Sát thủ 3: "${assassinsConfig[2].clue}"`;
                } else {
                    clueMessage = "Hệ thống đã hết manh mối để cung cấp!";
                }
                
                socket.emit('receive_reward', {
                    type: 'CLUE',
                    message: `🎉 CHÚC MỪNG BẠN TRẢ LỜI CHÍNH XÁC!<br>Đây là lần đúng thứ ${p.correctAnswersCount} của bạn.<br><br><b>${clueMessage}</b>`
                });
            } else if (p.role === 'ASSASSIN') {
                socket.emit('receive_reward', {
                    type: 'KILL_SKILL',
                    message: `🎉 CHÚC MỪNG SÁT THỦ TRẢ LỜI CHÍNH XÁC!<br><br><b>Nhiệm vụ hành động:</b> Hãy đi cụng ly hoặc hô hào mọi người lên bia với 1 mục tiêu Cảnh sát. Sau khi làm xong hành động ngoài đời, hãy chọn tên họ bên dưới để loại họ ngay lập tức!`
                });
            }
        }
    });

    socket.on('admin_force_end_minigame', () => { if (minigameActive) endMinigame(); });

    function startMinigameTimer(duration) {
        // Hàm phụ trợ nếu cần quản lý nâng cao bộ đếm
    }

    function endMinigame() {
        minigameActive = false;
        if (minigameTimeout) clearTimeout(minigameTimeout);
        const winners = minigameAnswers.slice(0, 3).map(ans => ans.name);
        io.emit('minigame_ended', winners);
        io.emit('force_close_question');
    }

    // LUỒNG MỞ BÌNH CHỌN: SERVER LỌC SẴN DANH SÁCH NGƯỜI SỐNG GỬI ĐI
    socket.on('admin_open_vote_round', () => {
        if (voteTimeout) clearTimeout(voteTimeout);
        voteActive = true;
        currentVotes = [];

        io.emit('close_all_overlays'); 
        
        // Server tự động xử lý lọc dữ liệu thô chuẩn đét trước khi phát đi
        const livingPlayers = Object.values(players)
            .filter(p => p.isAlive)
            .map(p => ({ id: p.id, name: p.name }));

        io.emit('open_vote_round', { duration: 60, targetList: livingPlayers });

        voteTimeout = setTimeout(() => { if (voteActive) endVoteRound(); }, 60000);
    });

    socket.on('submit_votes_round', (data) => {
        if (!voteActive) return;
        data.chosenIds.forEach(targetId => {
            currentVotes.push({
                targetId: targetId,
                votes: data.weight 
            });
        });
    });

    socket.on('admin_force_end_vote', () => { if (voteActive) endVoteRound(); });

    function endVoteRound() {
        voteActive = false;
        if (voteTimeout) clearTimeout(voteTimeout);

        let voteCounts = {};
        currentVotes.forEach(v => { voteCounts[v.targetId] = (voteCounts[v.targetId] || 0) + v.votes; });
        
        let top5 = Object.keys(voteCounts).sort((a, b) => voteCounts[b] - voteCounts[a]).slice(0, 5);
        let hasAssassin = top5.some(id => players[id] && players[id].role === "ASSASSIN");
        
        io.emit('vote_result_announced', { 
            hasAssassin: hasAssassin, 
            top5Names: top5.map(id => players[id] ? players[id].name : "Ẩn danh") 
        });
        io.emit('force_close_vote_screen');
    }

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update_player_list', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Hệ thống chạy mượt tại port ${PORT}`); });
