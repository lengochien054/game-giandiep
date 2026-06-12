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
let gameStatus = "LOBBY"; 
let minigameTimeout = null;
let minigameActive = false;
let currentCorrectAnswer = "";
let minigameAnswers = []; 

io.on('connection', (socket) => {
    console.log(`Kết nối mới: ${socket.id}`);

    // Gửi danh sách hiện tại cho máy mới kết nối (Tránh lỗi hiển thị 1 người)
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

    socket.on('kick_player_by_admin', (badPlayerSocketId) => {
        if (players[badPlayerSocketId]) {
            io.to(badPlayerSocketId).emit('kicked_by_admin');
            delete players[badPlayerSocketId];
            io.emit('update_player_list', Object.values(players));
        }
    });

    socket.on('start_game', () => {
        const playerIds = Object.keys(players);
        if (playerIds.length < 3) { 
            socket.emit('error_msg', 'Không đủ người chơi (Cần tối thiểu 3 người để chia phe)!');
            return;
        }

        gameStatus = "PLAYING";
        const shuffledIds = [...playerIds].sort(() => 0.5 - Math.random());
        
        // Tỷ lệ khoảng 15% là sát thủ (Tối thiểu 1, Tối đa 3)
        const numAssassins = Math.min(3, Math.max(1, Math.floor(playerIds.length * 0.15)));
        
        shuffledIds.forEach((id, index) => {
            if (index < numAssassins) { players[id].role = "ASSASSIN"; } 
            else { players[id].role = "POLICE"; }
        });

        // Báo vai trò riêng tư cho từng người
        shuffledIds.forEach(id => { 
            io.to(id).emit('receive_role', { role: players[id].role }); 
        });
        
        // Cập nhật danh sách kèm vai trò về cho Admin biết
        io.emit('update_player_list', Object.values(players));
    });

    socket.on('submit_clue', (clueText) => {
        if (players[socket.id] && players[socket.id].role === "ASSASSIN") {
            players[socket.id].clue = clueText;
            socket.emit('clue_saved');
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

        // HẾT 60 GIÂY: Tự động khóa sổ ép kết thúc luôn
        minigameTimeout = setTimeout(() => { if (minigameActive) endMinigame(); }, 60000);
    });

    socket.on('submit_minigame_answer', (answerText) => {
        if (!minigameActive) return;
        const p = players[socket.id];
        if (!p || !p.isAlive) return;

        const isCorrect = answerText.toUpperCase().trim() === currentCorrectAnswer;
        
        // Trả kết quả Ngay Lập Tức về máy người chơi để báo Đúng hay Sai
        socket.emit('minigame_feedback', { isCorrect: isCorrect });

        if (!minigameAnswers.some(ans => ans.id === socket.id)) {
            minigameAnswers.push({ id: socket.id, name: p.name, isCorrect: isCorrect, time: Date.now() });
        }
    });

    function endMinigame() {
        minigameActive = false;
        if (minigameTimeout) clearTimeout(minigameTimeout);

        // Lọc những người trả lời đúng và xếp theo thời gian nhanh nhất
        const correctAnswers = minigameAnswers.filter(ans => ans.isCorrect).sort((a, b) => a.time - b.time);
        const winners = correctAnswers.slice(0, 3).map(ans => ans.name);

        correctAnswers.slice(0, 3).forEach((ans, index) => {
            const targetSocket = io.sockets.sockets.get(ans.id);
            if (targetSocket && players[ans.id]) {
                if (players[ans.id].role === 'ASSASSIN') {
                    targetSocket.emit('receive_reward', { type: 'KILL_SKILL', message: `🏆 TOP ${index+1} NHANH NHẤT! Bạn nhận được đặc quyền Ám Sát ngầm.` });
                } else {
                    // Lấy ngẫu nhiên manh mối của 1 sát thủ còn sống
                    const assassins = Object.values(players).filter(pl => pl.role === "ASSASSIN" && pl.clue);
                    let randomClue = "Sát thủ ẩn mình rất kỹ, hệ thống chưa quét được đặc điểm.";
                    if(assassins.length > 0) {
                        randomClue = assassins[Math.floor(Math.random() * assassins.length)].clue;
                    }
                    targetSocket.emit('receive_reward', { type: 'CLUE', message: `🏆 TOP ${index+1} NHANH NHẤT! Manh mối quét được: "${randomClue}"` });
                }
            }
        });

        io.emit('minigame_ended', winners);
        io.emit('force_close_question'); // Ép tất cả các máy đóng màn hình câu hỏi
    }

    socket.on('open_vote_round', () => {
        io.emit('open_vote_round'); // Kích hoạt lệnh mở bảng bầu chọn xuống toàn phòng
    });

    socket.on('submit_votes_round', (votesArray) => {
        let voteCounts = {};
        votesArray.forEach(v => { voteCounts[v.targetId] = (voteCounts[v.targetId] || 0) + v.votes; });
        let top5 = Object.keys(voteCounts).sort((a, b) => voteCounts[b] - voteCounts[a]).slice(0, 5);
        let hasAssassin = top5.some(id => players[id] && players[id].role === "ASSASSIN");
        
        io.emit('vote_result_announced', { 
            hasAssassin: hasAssassin, 
            top5Names: top5.map(id => players[id] ? players[id].name : "Ẩn danh") 
        });
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update_player_list', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Hệ thống chạy mượt tại port ${PORT}`); });
