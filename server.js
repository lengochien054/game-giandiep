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
let clueQueue = [];
let nextClueIndex = 0;
let minigameTimeout = null;
let minigameActive = false;
let currentCorrectAnswer = "";
let minigameAnswers = []; 
let clueReleasedThisMinigame = false;
let currentMinigameClueMessage = "";

let voteTimeout = null;
let voteActive = false;
let currentVotes = []; 

io.on('connection', (socket) => {
    console.log(`Káº¿t ná»‘i: ${socket.id}`);
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

    function normalizeHints(hints) {
        if (Array.isArray(hints)) {
            return hints.map(h => String(h).trim()).filter(Boolean);
        }
        return String(hints || "")
            .split(/\r?\n|;/)
            .map(h => h.trim())
            .filter(Boolean);
    }

    function buildClueQueue(config) {
        const queue = [];
        const maxHints = Math.max(0, ...config.map(as => as.hints.length));

        for (let hintIndex = 0; hintIndex < maxHints; hintIndex += 1) {
            config.forEach((as, assassinIndex) => {
                if (as.hints[hintIndex]) {
                    queue.push({
                        assassinNumber: assassinIndex + 1,
                        text: as.hints[hintIndex]
                    });
                }
            });
        }

        return queue;
    }

    function getNextClue() {
        const clue = clueQueue[nextClueIndex];
        if (!clue) return null;
        nextClueIndex += 1;
        return clue;
    }

    function sendClueToPolice(playerId, clueMessage) {
        io.to(playerId).emit('receive_reward', {
            type: 'CLUE',
            message: `<b>${clueMessage}</b>`
        });
    }

    socket.on('admin_assign_roles', (data) => {
        assassinsConfig = (data.assassins || [])
            .filter(as => as.id && players[as.id])
            .map(as => ({
                id: as.id,
                hints: normalizeHints(as.hints || as.clue)
            }));
        clueQueue = buildClueQueue(assassinsConfig);
        nextClueIndex = 0;

        Object.keys(players).forEach(id => {
            players[id].role = "POLICE";
            players[id].clue = "";
            players[id].hints = [];
            players[id].correctAnswersCount = 0;
            players[id].stolenVotes = 0;
        });

        assassinsConfig.forEach((as) => {
            players[as.id].role = "ASSASSIN";
            players[as.id].hints = as.hints;
            players[as.id].clue = as.hints[0] || "";
        });

        Object.keys(players).forEach(id => {
            if (players[id].role === "ASSASSIN") {
                io.to(id).emit('receive_role', { 
                    role: "ASSASSIN", 
                    message: `Ban la sat thu. Quan tro da cau hinh ${players[id].hints.length} goi y ve ban.`
                });
            } else {
                io.to(id).emit('receive_role', { 
                    role: "POLICE", 
                    message: "Xin chÃ o cáº£nh sÃ¡t, hÃ£y mau chÃ³ng tÃ¬m ra sÃ¡t thá»§ trÆ°á»›c khi bá»‹ loáº¡i"
                });
            }
        });

        io.emit('update_player_list', Object.values(players));
    });

    socket.on('admin_add_assassin_hints', (data) => {
        const newHints = normalizeHints(data && data.hints);
        if (newHints.length === 0) return;

        newHints.forEach(text => clueQueue.push({
            assassinNumber: null,
            text
        }));

        io.emit('assassin_hints_updated', {
            remainingHints: Math.max(0, clueQueue.length - nextClueIndex),
            addedHints: newHints.length
        });
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
        clueReleasedThisMinigame = false;
        currentMinigameClueMessage = "";

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
                if (!clueReleasedThisMinigame) {
                    clueReleasedThisMinigame = true;
                    const nextClue = getNextClue();

                    if (nextClue) {
                        const targetText = nextClue.assassinNumber ? `Sat thu ${nextClue.assassinNumber}` : "sat thu";
                        currentMinigameClueMessage = `Goi y ve ${targetText}: "${nextClue.text}"`;
                    } else {
                        currentMinigameClueMessage = "He thong da het goi y. Quan tro can nhap them goi y!";
                        io.emit('assassin_hints_empty');
                    }
                }

                sendClueToPolice(socket.id, currentMinigameClueMessage);
                return;
            }

            if (p.role === 'ASSASSIN') {
                socket.emit('receive_reward', {
                    type: 'KILL_SKILL',
                    message: `ðŸŽ‰ CHÃšC Má»ªNG SÃT THá»¦ TRáº¢ Lá»œI CHÃNH XÃC!<br><br><b>Nhiá»‡m vá»¥ hÃ nh Ä‘á»™ng:</b> HÃ£y Ä‘i cá»¥ng ly hoáº·c hÃ´ hÃ o má»i ngÆ°á»i lÃªn bia vá»›i 1 má»¥c tiÃªu Cáº£nh sÃ¡t. Sau khi lÃ m xong hÃ nh Ä‘á»™ng ngoÃ i Ä‘á»i, hÃ£y chá»n tÃªn há» bÃªn dÆ°á»›i Ä‘á»ƒ loáº¡i há» ngay láº­p tá»©c!`
                });
            }
        }
    });

    socket.on('admin_force_end_minigame', () => { if (minigameActive) endMinigame(); });

    function startMinigameTimer(duration) {
        // HÃ m phá»¥ trá»£ náº¿u cáº§n quáº£n lÃ½ nÃ¢ng cao bá»™ Ä‘áº¿m
    }

    function endMinigame() {
        minigameActive = false;
        if (minigameTimeout) clearTimeout(minigameTimeout);
        const winners = minigameAnswers.slice(0, 3).map(ans => ans.name);
        io.emit('minigame_ended', winners);
        io.emit('force_close_question');
    }

    // LUá»’NG Má»ž BÃŒNH CHá»ŒN: SERVER Lá»ŒC Sáº´N DANH SÃCH NGÆ¯á»œI Sá»NG Gá»¬I ÄI
    socket.on('admin_open_vote_round', () => {
        if (voteTimeout) clearTimeout(voteTimeout);
        voteActive = true;
        currentVotes = [];

        io.emit('close_all_overlays'); 
        
        // Server tá»± Ä‘á»™ng xá»­ lÃ½ lá»c dá»¯ liá»‡u thÃ´ chuáº©n Ä‘Ã©t trÆ°á»›c khi phÃ¡t Ä‘i
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
        
        const sortedIds = Object.keys(voteCounts).sort((a, b) => voteCounts[b] - voteCounts[a]);
        const highestVote = sortedIds.length > 0 ? voteCounts[sortedIds[0]] : 0;
        const top1 = sortedIds.filter(id => voteCounts[id] === highestVote);
        const eliminatedAssassins = top1.filter(id => players[id] && players[id].role === "ASSASSIN" && players[id].isAlive);

        eliminatedAssassins.forEach(id => {
            players[id].isAlive = false;
            io.to(id).emit('you_are_dead');
            io.emit('player_died', { victimName: players[id].name });
        });

        let hasAssassin = eliminatedAssassins.length > 0;
        const top5 = top1;
        
        io.emit('vote_result_announced', { 
            hasAssassin: hasAssassin, 
            top1Names: top1.map(id => players[id] ? players[id].name : "An danh"),
            eliminatedNames: eliminatedAssassins.map(id => players[id].name),
            top5Names: top5.map(id => players[id] ? players[id].name : "áº¨n danh") 
        });
        io.emit('update_player_list', Object.values(players));
        io.emit('force_close_vote_screen');
    }

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update_player_list', Object.values(players));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Há»‡ thá»‘ng cháº¡y mÆ°á»£t táº¡i port ${PORT}`); });
