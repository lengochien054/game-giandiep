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
let currentVotes = []; // Lưu danh sách phiếu [{voterId, targetId, votesCount}]

io.on('connection', (socket) => {
    console.log(`Kết nối: ${socket.id}`);
    
    // Gửi danh sách cập nhật ngay lập tức cho tất cả các máy bao gồm cả Admin
    io.emit('update_player_list', Object.values(players));

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

    // ADMIN THỦ CÔNG CHỈ ĐỊNH VAI TRÒ HOẶC CHO CHẠY TỰ ĐỘNG
    socket.on('admin_assign_roles', (assignedList) => {
        // assignedList mẫu: [{id: '...', role: 'ASSASSIN'}, {id: '...', role: 'POLICE'}]
        assignedList.forEach(item => {
            if (players[item.id]) {
                players[item.id].role = item.role;
                // Bắn vai trò bí mật về máy cá nhân đó
                io.to(item.id).emit('receive_role', { role: item.role });
            }
        });
        // Cập nhật lại sơ đồ danh sách hiển thị cho Admin biết
        io.emit('update_player_list', Object.values(players));
    });

    socket.on('submit_clue', (clueText) => {
        if (players[socket.id] && players[socket.id].role === "ASSASSIN") {
            players[socket.id].clue = clueText;
            socket.emit('clue_saved');
            io.emit('update_player_list', Object.values(players)); // Đồng bộ cho Admin thấy đã nhập gợi ý
        }
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

    // LUỒNG MINI-GAME CÓ THỜI GIAN ĐẾM NGƯỢC
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

    // ĐÓNG MINI-GAME VÀ PHÂN PHÁT PHẦN THƯỞNG CHI TIẾT ĐÚNG / SAI
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
                    // Cảnh sát thắng: Gom toàn bộ manh mối của các Sát thủ đã nhập
                    const assassins = Object.values(players).filter(pl => pl.role === "ASSASSIN" && pl.clue);
                    let cluesList = assassins.map((as, i) => `Sát thủ ${i+1}: "${as.clue}"`).join("<br>");
                    if(!cluesList) cluesList = "Sát thủ chưa khai báo manh mối hoặc giấu kín.";

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

    // LUỒNG BÌNH CHỌN 60 GIÂY TỰ ĐỘNG KHÓA CỔNG
    socket.on('admin_open_vote_round', () => {
        if (voteTimeout) clearTimeout(voteTimeout);
        voteActive = true;
        currentVotes = [];

        // Phát tín hiệu mở giao diện kèm thời gian lùi số 60s cho người chơi
        io.emit('open_vote_round', { duration: 60 });

        voteTimeout = setTimeout(() => { if (voteActive) endVoteRound(); }, 60000);
    });

    socket.on('submit_votes_round', (votesArray) => {
        if (!voteActive) return;
        // votesArray mẫu: [{targetId: '...', votes: 1}]
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
            top5Names: top5.map(id => players[id] ? players[id].name : "Nghi phạm ẩn danh") 
        });
        io.emit('force_close_vote_screen'); // Ép máy người chơi đóng màn hình bầu chọn
    }

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update_player_list', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Hệ thống ổn định tại port ${PORT}`); });
