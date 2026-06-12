const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Cho phép mọi thiết bị/điện thoại kết nối vào
});

// Lưu trữ trạng thái game trong bộ nhớ (Memory DB)
let players = {}; 
// Cấu trúc: { socketId: { id, name, role, isAlive, stolenVotes, clue } }
let gameStatus = "LOBBY"; // LOBBY, PLAYING, VOTE_1, VOTE_2, FINAL_VOTE

io.on('connection', (socket) => {
    console.log(`Người chơi kết nối: ${socket.id}`);

    // 1. Người chơi đăng nhập vào phòng chờ
    socket.on('join_game', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name,
            role: "PENDING", // Sẽ cập nhật khi start game
            isAlive: true,
            stolenVotes: 0, // Số lượt vote cướp được từ người chết
            clue: ""
        };
        // Gửi lại danh sách toàn bộ phòng cho mọi người xem realtime
        io.emit('update_player_list', Object.values(players));
    });

    // 2. QUẢN TRÒ (HOST) BẮT ĐẦU GAME - CHỈ ĐỊNH SÁT THỦ
    socket.on('start_game', () => {
        const playerIds = Object.keys(players);
        if (playerIds.length < 5) { // Test thì để ít, chơi thật cần đông
            socket.emit('error', 'Không đủ người chơi để bắt đầu!');
            return;
        }

        gameStatus = "PLAYING";
        
        // Chọn ngẫu nhiên 3 sát thủ
        let assassinsCount = 0;
        const shuffledIds = playerIds.sort(() => 0.5 - Math.random());
        
        shuffledIds.forEach((id, index) => {
            if (index < 3) {
                players[id].role = "ASSASSIN";
            } else {
                players[id].role = "POLICE";
            }
        });

        // Gửi vai trò bí mật về cho từng điện thoại
        shuffledIds.forEach(id => {
            io.to(id).emit('receive_role', { role: players[id].role });
        });

        io.emit('game_status_changed', gameStatus);
    });

    // 3. SÁT THỦ CẬP NHẬT MANH MỐI ĐẦU GAME
    socket.on('submit_clue', (clueText) => {
        if (players[socket.id] && players[socket.id].role === "ASSASSIN") {
            players[socket.id].clue = clueText;
            socket.emit('clue_saved', true);
        }
    });

    // 4. LUỒNG ÁM SÁT (Sát thủ cụng ly xong chọn tên nạn nhân trên web)
    socket.on('assassinate_player', (targetId) => {
        const killer = players[socket.id];
        const victim = players[targetId];

        if (killer && killer.role === "ASSASSIN" && victim && victim.isAlive) {
            victim.isAlive = false; // Nạn nhân tử trận
            killer.stolenVotes += 1; // Sát thủ cướp được 1 lượt vote

            // Báo riêng cho nạn nhân chết (Khóa màn hình điện thoại)
            io.to(targetId).emit('you_are_dead');

            // Thông báo công khai cho cả phòng phát hiện có người chết
            io.emit('player_died', { 
                victimName: victim.name, 
                updatedPlayers: Object.values(players) 
            });
        }
    });

    // 5. XỬ LÝ KIỂM TRA TOP 5 (Vòng Bình Chọn 1 & 2)
    // Client gửi lên mảng danh sách vote: [{targetId: '...', votes: 3}]
    socket.on('submit_votes_round', (votesArray) => {
        // Gom tổng số vote cho từng người
        let voteCounts = {};
        votesArray.forEach(v => {
            voteCounts[v.targetId] = (voteCounts[v.targetId] || 0) + v.votes;
        });

        // Sắp xếp tìm Top 5 người bị vote cao nhất
        let top5 = Object.keys(voteCounts)
            .sort((a, b) => voteCounts[b] - voteCounts[a])
            .slice(0, 5);

        // Kiểm tra xem trong Top 5 có chứa Sát thủ nào không
        let hasAssassin = top5.some(id => players[id] && players[id].role === "ASSASSIN");

        // Trả kết quả ẩn danh về cho toàn bộ phòng
        io.emit('vote_result_announced', {
            hasAssassin: hasAssassin, // Chỉ trả ra true/false đúng như kịch bản
            top5Names: top5.map(id => players[id]?.name) // Để hiển thị 5 cái tên lên màn hình
        });
    });
// ========================================================
    // 1. LOGIC XỬ LÝ MINI-GAME TỐC CHIẾN (CHẠY REALTIME)
    // ========================================================
    let currentQuestion = null;
    let fastAnswers = []; // Lưu danh sách những người trả lời đúng [{socketId, name, timeTaken}]

    // Quản trò (Host) phát lệnh tung câu hỏi Mini-Game
    socket.on('host_trigger_minigame', (questionData) => {
        // questionData mẫu: { id: 1, question: "Mắt + Giọt nước + Con cá = ?", correctAnswer: "Nước mắm" }
        currentQuestion = questionData;
        fastAnswers = []; // Reset danh sách câu trả lời mới

        // Phát đồng loạt câu hỏi xuống 30 điện thoại kèm thời điểm phát (timestamp)
        io.emit('receive_minigame_question', {
            id: currentQuestion.id,
            question: currentQuestion.question,
            startTime: Date.now() // Dùng để tính thời gian phản xạ của người chơi
        });
    });

    // Điện thoại người chơi gửi đáp án lên server
    socket.on('submit_minigame_answer', (userAnswer) => {
        if (!currentQuestion) return;
        if (fastAnswers.length >= 3) return; // Đủ 3 người nhanh nhất rồi thì khóa sổ

        // Kiểm tra xem người này đã trả lời trước đó chưa để tránh spam
        const alreadyAnswered = fastAnswers.some(ans => ans.socketId === socket.id);
        if (alreadyAnswered) return;

        // Chuẩn hóa chữ để so sánh đáp án (viết thường, bỏ khoảng cách thừa)
        const isCorrect = userAnswer.trim().toLowerCase() === currentQuestion.correctAnswer.trim().toLowerCase();

        if (isCorrect) {
            const timeTaken = Date.now(); // Ghi nhận thời điểm trả lời đúng
            fastAnswers.push({
                socketId: socket.id,
                name: players[socket.id]?.name,
                role: players[socket.id]?.role,
                timeTaken: timeTaken
            });

            // Nếu đã thu thập đủ 3 người trả lời đúng nhanh nhất
            if (fastAnswers.length === 3) {
                processMiniGameRewards(fastAnswers);
                currentQuestion = null; // Đóng câu hỏi hiện tại
            }
        }
    });

    // Hàm tự động tính toán và phát thưởng riêng tư qua Socket
    function processMiniGameRewards(winners) {
        winners.forEach((winner) => {
            const playerSocketId = winner.socketId;
            const playerRole = winner.role;

            if (playerRole === "POLICE") {
                // Thưởng cho Cảnh sát: Lấy ngẫu nhiên manh mối của 1 trong các Sát thủ còn sống
                const assassins = Object.values(players).filter(p => p.role === "ASSASSIN" && p.isAlive);
                if (assassins.length > 0) {
                    const randomAssassin = assassins[Math.floor(Math.random() * assassins.length)];
                    io.to(playerSocketId).emit('receive_reward', {
                        type: "CLUE",
                        message: `GỢI Ý MẬT: Một trong các Sát thủ có đặc điểm: "${randomAssassin.clue}"`
                    });
                } else {
                    io.to(playerSocketId).emit('receive_reward', { type: "MESSAGE", message: "Không còn sát thủ nào sống sót." });
                }
            } 
            else if (playerRole === "ASSASSIN") {
                // Thưởng cho Sát thủ: Cấp "Kỹ năng ẩn" cụng ly hoặc hô bia để giết người
                io.to(playerSocketId).emit('receive_reward', {
                    type: "KILL_SKILL",
                    message: "BẠN NHẬN ĐƯỢC 1 ĐẠN ÁM SÁT! Hãy đi cụng ly hoặc hô bia với 1 mục tiêu, sau đó chọn tên họ trên điện thoại để hạ sát."
                });
            }
        });

        // Báo danh tính 3 người thắng cuộc (không lộ vai trò) lên màn hình Admin/Group chung để chúc mừng
        io.emit('minigame_ended', winners.map(w => w.name));
    }


    // ========================================================
    // 2. LOGIC TÍNH TOÁN KẾT QUẢ VÒNG CHỐT HẠ (LƯỢT 3)
    // ========================================================
    // Client gửi lên mảng tất cả các vote cho Top 5: [{ voterId, targetId, votesCount }]
    socket.on('submit_final_votes', (allVotesArray) => {
        gameStatus = "FINAL_VOTE";

        let finalVoteCounts = {}; // Lưu tổng số phiếu của từng người trong Top 5
        
        // Tính tổng điểm vote (có cộng dồn các vote cướp được từ người chết)
        allVotesArray.forEach(v => {
            finalVoteCounts[v.targetId] = (finalVoteCounts[v.targetId] || 0) + v.votesCount;
        });

        // Sắp xếp Top 5 từ cao xuống thấp dựa trên số phiếu nhận được
        let sortedFinalists = Object.keys(finalVoteCounts).sort((a, b) => finalVoteCounts[b] - finalVoteCounts[a]);

        // Lấy ra 3 người có số phiếu bầu CAO NHẤT trong đêm chung kết
        let top3Executed = sortedFinalists.slice(0, 3);

        // Đếm xem trong 3 người bị thanh trừng này có bao nhiêu Sát thủ thực sự
        let caughtAssassinsCount = 0;
        top3Executed.forEach(id => {
            if (players[id] && players[id].role === "ASSASSIN") {
                caughtAssassinsCount++;
            }
        });

        // Áp dụng ĐÚNG ĐIỀU KIỆN THẮNG: Bắt được từ 2 sát thủ trở lên -> Cảnh sát thắng
        let gameWinner = "ASSASSINS"; // Mặc định sát thủ thắng
        if (caughtAssassinsCount >= 2) {
            gameWinner = "POLICE";
        }

        // Trả kết quả chốt hạ cuối cùng để Web bung hiệu ứng vinh quang
        io.emit('game_over_announced', {
            winnerPhe: gameWinner, // "POLICE" hoặc "ASSASSINS"
            caughtCount: caughtAssassinsCount, // Bắt được mấy tên
            allAssassins: Object.values(players)
                .filter(p => p.role === "ASSASSIN")
                .map(p => ({ name: p.name, isAlive: p.isAlive })) // Lộ mặt toàn bộ sát thủ khi kết thúc game
        });
    });
    // Người chơi mất kết nối
    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update_player_list', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server game đang chạy tại port ${PORT}`);
});
