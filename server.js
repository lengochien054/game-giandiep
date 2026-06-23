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
let spyHistory = {}; // Lưu trữ nhật ký xem ai đã từng làm gián điệp nhằm đảm bảo ai cũng được làm 1 lần

let minigameTimeout = null;
let minigameActive = false;
let currentCorrectAnswer = "";

let voteTimeout = null;
let voteActive = false;
let currentVotes = []; // Lưu phiếu vote [{voterId, chosenIds: []}]
let currentSpyCount = 5; // Số lượng gián điệp mặc định

io.on('connection', (socket) => {
    console.log(`Kết nối: ${socket.id}`);
    socket.emit('update_player_list', Object.values(players));

    socket.on('join_game', (data) => {
        // Nếu người chơi cũ rớt mạng vào lại, giữ nguyên điểm số
        if (!players[socket.id]) {
            players[socket.id] = {
                id: socket.id,
                name: data.name,
                role: "PENDING",
                isAlive: true,
                score: 0, // Lưu tổng điểm xuyên suốt các lượt
                desc: "", // Câu mô tả từ khóa
                votedSpiesCount: 0,
                beVotedCount: 0
            };
        }
        io.emit('update_player_list', Object.values(players));
    });

    socket.on('kick_player_by_admin', (badPlayerId) => {
        if (players[badPlayerId]) {
            io.to(badPlayerId).emit('kicked_by_admin');
            delete players[badPlayerId];
            io.emit('update_player_list', Object.values(players));
        }
    });

    // LUỒNG CHIA BÀI THÔNG MINH - ĐẢM BẢO AI CŨNG LÀM GIÁN ĐIỆP ĐÚNG 1 LẦN
    socket.on('admin_start_new_round', (data) => {
        // data: { normalWord: "Tuổi trẻ", spyWord: "Thanh xuân", spyCount: 5 }
        const playerIds = Object.keys(players);
        if (playerIds.length < 3) {
            socket.emit('error_msg', 'Không đủ người chơi để chạy lượt mới!');
            return;
        }

        currentSpyCount = parseInt(data.spyCount) || 5;
        minigameActive = true; 
        currentVotes = [];

        // Bắn thông báo số lượng gián điệp xuống app của tất cả mọi người
        io.emit('announce_spy_config', { spyCount: currentSpyCount });

        // Lọc ra những người CHƯA TỪNG làm gián điệp để ưu tiên bốc trước
        let candidateIds = playerIds.filter(id => !spyHistory[players[id].name]);
        
        // Nếu ai cũng làm gián điệp rồi thì reset lịch sử để xoay vòng mới
        if (candidateIds.length < currentSpyCount) {
            spyHistory = {};
            candidateIds = playerIds;
        }

        // Trộn ngẫu nhiên danh sách ứng viên gián điệp
        let shuffledCandidates = [...candidateIds].sort(() => 0.5 - Math.random());
        let selectedSpyIds = shuffledCandidates.slice(0, currentSpyCount);

        // Gán vai trò và phát từ khóa bí mật xuống máy người chơi
        playerIds.forEach(id => {
            players[id].desc = ""; // Reset mô tả cũ
            if (selectedSpyIds.includes(id)) {
                players[id].role = "SPY";
                spyHistory[players[id].name] = true; // Ghi nhận nhật ký
                io.to(id).emit('receive_word_package', { 
                    role: "SPY", 
                    word: data.spyWord,
                    message: `Bạn là GIÁN ĐIỆP 🩸. Từ khóa ẩn danh của bạn là: "${data.spyWord}". Hãy dùng 1-2 từ mô tả để lừa Cảnh sát!`
                });
            } else {
                players[id].role = "NORMAL";
                io.to(id).emit('receive_word_package', { 
                    role: "NORMAL", 
                    word: data.normalWord,
                    message: `Bạn là người BÌNH THƯỜNG 🛡️. Từ khóa của bạn là: "${data.normalWord}". Hãy nhập 1-2 từ mô tả chính xác!`
                });
            }
        });

        io.emit('start_desc_phase', { duration: 60 });
        io.emit('update_player_list', Object.values(players));

        // Tự động khóa sổ phase nhập mô tả sau 60 giây
        if (minigameTimeout) clearTimeout(minigameTimeout);
        minigameTimeout = setTimeout(() => {
            io.emit('force_close_desc_phase');
            minigameActive = false;
        }, 60000);
    });

    // NGƯỜI CHƠI NỘP CÂU MÔ TẢ
    socket.on('submit_description', (text) => {
        if (players[socket.id]) {
            players[socket.id].desc = text;
            io.emit('update_player_list', Object.values(players)); // Hiện realtime câu mô tả lên màn hình Admin
        }
    });

    // QUẢN TRÒ MỞ CỔNG BÌNH CHỌN 60 GIÂY
    socket.on('admin_open_vote_round', () => {
        if (voteTimeout) clearTimeout(voteTimeout);
        voteActive = true;
        currentVotes = [];

        const cleanList = Object.values(players).map(p => ({ id: p.id, name: p.name, desc: p.desc || "Chưa nhập mô tả" }));
        io.emit('open_vote_round', { duration: 60, playerList: cleanList, requiredSelectCount: currentSpyCount });

        voteTimeout = setTimeout(() => { if (voteActive) calculateRoundScores(); }, 60000);
    });

    // TIẾP NHẬN PHIẾU BẦU
    socket.on('submit_votes_round', (data) => {
        if (!voteActive) return;
        // data: { voterId: '...', chosenIds: ['id1', 'id2', ...] }
        currentVotes.push(data);
    });

    socket.on('admin_force_end_vote', () => { if (voteActive) calculateRoundScores(); });

    // HÀM TÍNH ĐIỂM SỐ TỰ ĐỘNG THUẬN TOÁN MỚI (+10 / -5)
    function calculateRoundScores() {
        voteActive = false;
        if (voteTimeout) clearTimeout(voteTimeout);

        // Reset bộ đếm vòng này
        Object.keys(players).forEach(id => {
            players[id].votedSpiesCount = 0;
            players[id].beVotedCount = 0;
        });

        // Đếm số phiếu bầu
        currentVotes.forEach(votePack => {
            votePack.chosenIds.forEach(targetId => {
                if (players[targetId]) {
                    players[targetId].beVotedCount += 1; // Đếm số phiếu người này bị nhận
                    
                    // Nếu người bầu vote trúng Gián điệp thực sự
                    if (players[targetId].role === "SPY" && players[votePack.voterId]) {
                        players[votePack.voterId].votedSpiesCount += 1;
                    }
                }
            });
        });

        // Áp dụng công thức tính điểm toán học
        Object.keys(players).forEach(id => {
            let p = players[id];
            if (p.role === "NORMAL") {
                // Người bình thường: chọn đúng 1 gián điệp được +10 điểm
                p.score += p.votedSpiesCount * 10;
            } else if (p.role === "SPY") {
                // Gián điệp: Bị chọn trúng 1 phiếu bị trừ 5 điểm
                p.score -= p.beVotedCount * 5;
            }
        });

        // Phát tín hiệu thông báo vòng này kết thúc
        io.emit('vote_round_ended');
        io.emit('update_player_list', Object.values(players));
    }

    // QUẢN TRÒ BẤM NÚT TỔNG KẾT ĐỂ XUẤT BẢNG XẾP HẠNG CHUNG CUỘC
    socket.on('admin_trigger_summary', () => {
        // Sắp xếp danh sách từ trên xuống dưới theo điểm số
        let leaderboard = Object.values(players).sort((a, b) => b.score - a.score);
        io.emit('game_over_leaderboard', leaderboard);
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update_player_list', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Hệ thống chạy mượt tại port ${PORT}`); });
