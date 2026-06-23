const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Cấu hình thư mục tĩnh để truy cập index.html và admin.html
app.use(express.static(path.join(__dirname)));

// Lưu trữ danh sách người chơi dưới dạng Object (key là socket.id)
let players = {};

io.on('connection', (socket) => {
    console.log(`Người dùng kết nối: ${socket.id}`);

    // 1. Khi người chơi tham gia (từ index.html)
    socket.on('joinGame', (username) => {
        players[socket.id] = { id: socket.id, name: username };
        // Cập nhật lại danh sách cho toàn bộ các client (bao gồm cả admin)
        io.emit('updatePlayerList', Object.values(players));
    });

    // 2. Khi quản trò đăng nhập/vào trang admin (từ admin.html)
    socket.on('adminInit', () => {
        // Gửi danh sách người chơi hiện tại riêng cho admin vừa kết nối
        socket.emit('updatePlayerList', Object.values(players));
    });

    // 3. Khi quản trò yêu cầu xóa một người chơi
    socket.on('kickPlayer', (playerId) => {
        if (players[playerId]) {
            console.log(`Quản trò đã xóa người chơi: ${players[playerId].name}`);
            
            // Thông báo riêng cho người chơi đó biết mình bị kích
            io.to(playerId).emit('youAreKicked');
            
            // Xóa khỏi danh sách bộ nhớ hệ thống
            delete players[playerId];
            
            // Cập nhật lại danh sách mới cho tất cả mọi người
            io.emit('updatePlayerList', Object.values(players));
        }
    });

    // 4. Khi một người ngắt kết nối (đóng tab/mất mạng)
    socket.on('disconnect', () => {
        if (players[socket.id]) {
            console.log(`Người chơi thoát: ${players[socket.id].name}`);
            delete players[socket.id];
            io.emit('updatePlayerList', Object.values(players));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
