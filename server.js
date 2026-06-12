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
let minigameTimeout = null;
let minigameActive = false;
let currentCorrectAnswer = "";
let minigameAnswers = []; 

let voteTimeout = null;
let voteActive = false;
let currentVotes = []; 

io.on('connection', (socket) => {
    console.log(`Kết nối: ${socket.id}`);
    
    // Gửi danh sách cho thiết bị mới vào phòng
    socket.emit('update_player_list', Object.values(players));

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

    socket.on('kick_player_by_admin', (badPlayerId) => {
        if (players[badPlayerId]) {
            io.to(badPlayerId).emit('kicked_by_admin');
            delete players[badPlayerId];
            io.emit('update_player_list', Object.values(players));
        }
    });

    // XỬ LÝ CHỈ ĐỊNH ĐÍCH DANH 3 SÁT THỦ VÀ GỢI Ý TỪ ADMIN
    socket.on('admin_assign_roles', (data) => {
        // data mẫu: { assassins: [ {id, clue}, {id, clue}, {id, clue} ] }
        const assassinIds = data.assassins.map(as => as.id).filter(id => id !== "");

        // Reset lại toàn bộ vai trò phòng về mặc định trước khi chia
        Object.keys(players).forEach(id => {
            players[id].role = "POLICE";
            players[id].clue = "";
        });

        // Áp đặt cấu hình Sát thủ
        data.assassins.forEach(as => {
            if (as.id && players[as.id]) {
                players[as.id].role = "ASSASSIN";
                players[as.id].clue = as.clue;
            }
        });

        // Bắn thông báo nội dung chuẩn xác cho từng thiết bị người chơi
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

        // Đồng bộ lại sơ đồ hiển thị cho Admin
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

        if (!minigameAnswers.some(ans => ans.id === socket.id)) {
            minigameAnswers.push({ id: socket.id, name: p.name, isCorrect: isCorrect, time: Date.now() });
        }
    });

    socket.on('admin_force_end_minigame', () => { if (minigameActive) endMinigame(); });

    function endMinigame() {
        minigameActive = false;
        if (minigameTimeout) clearTimeout(minigameTimeout);

        const correctAnswers = minigameAnswers.filter(ans => ans.isCorrect).sort((a, b) => a.time - b.time);
        const winners = correctAnswers.slice(0, 3).map(ans => ans.name);

        correctAnswers.slice(0, 3).forEach((ans, index) => {
            const targetSocket = io.sockets.sockets.get(ans.id);
            if (targetSocket && players[ans.id]) {
                if (players[ans.id].role === 'ASSASSIN') {
                    targetSocket.emit('receive_reward', { 
                        type: 'KILL_SKILL', 
                        message: `🏆 TOP ${index+1} XUẤT SẮC! Hệ thống cấp Đạn: Hãy chọn 1 người sống bên dưới bàn tiệc, sau khi cụng ly / hô bia xong hãy bấm nút Kích hoạt để hạ sát họ ngầm!` 
                    });
                } else {
                    const assassins = Object.values(players).filter(pl => pl.role === "ASSASSIN" && pl.clue);
                    let cluesList = assassins.map((as, i) => `Sát thủ ${i+1}: "${as.clue}"`).join("<br>");
                    if(!cluesList) cluesList = "Sát thủ giấu kín, hệ thống chưa quét được manh mối.";

                    targetSocket.emit('receive_reward', { 
                        type: 'CLUE', 
                        message: `🏆 TOP ${index+1} XUẤT SẮC! Hệ thống rò rỉ dữ liệu mật:<br>${cluesList}` 
                    });
                }
            }
        });

        io.emit('minigame_ended', winners);
        io.emit('force_close_question');
    }

    socket.on('admin_open_vote_round', () => {
        if (voteTimeout) clearTimeout(voteTimeout);
        voteActive = true;
        currentVotes = [];
        io.emit('open_vote_round', { duration: 60 });
        voteTimeout = setTimeout(() => { if (voteActive) endVoteRound(); }, 60000);
    });

    socket.on('submit_votes_round', (votesArray) => {
        if (!voteActive) return;
        currentVotes = currentVotes.concat(votesArray);
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
