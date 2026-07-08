const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// ---- Config / limits ----
const MAX_NICKNAME_LENGTH = 20;
const MAX_CHAT_MESSAGE_LENGTH = 500;
const MAX_CHAT_HISTORY = 100;
const MAX_ACTIONS_PER_PAGE = 3000;
const MAX_PAGES_PER_ROOM = 20;

// Serve static files reliably from the "public" directory
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// In-memory storage for room data.
// NOTE: This is intentionally in-memory (no database). Restarting the server
// wipes all rooms, boards, and chat history. See README "Known Limitations".
// Structure: { roomId: { users: {}, pages: [], chat: [] } }
// users: { socketId: { nickname: '...', cursor: { x, y } } }
const rooms = {};

// ---- Sanitization helpers ----
// We only trim/limit length here. We deliberately do NOT HTML-escape on the
// server, because the client renders all user-supplied text via
// `textContent` (never `innerHTML`), which is immune to injection by
// construction. Escaping on both ends would double-encode entities.
function sanitizeNickname(nickname) {
    if (typeof nickname !== 'string') return '';
    return nickname.trim().slice(0, MAX_NICKNAME_LENGTH);
}

function sanitizeChatMessage(message) {
    if (typeof message !== 'string') return '';
    return message.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
}

function isValidActionId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 100;
}

// ---- Simple per-socket rate limiting (fixed window) ----
function createRateLimiter(maxEvents, windowMs) {
    const hits = new Map(); // socketId -> { count, windowStart }
    return {
        isAllowed(socketId) {
            const now = Date.now();
            const entry = hits.get(socketId);
            if (!entry || now - entry.windowStart > windowMs) {
                hits.set(socketId, { count: 1, windowStart: now });
                return true;
            }
            if (entry.count >= maxEvents) return false;
            entry.count++;
            return true;
        },
        cleanup(socketId) {
            hits.delete(socketId);
        }
    };
}

const drawingLimiter = createRateLimiter(200, 1000); // ~200 stroke segments/sec
const cursorLimiter = createRateLimiter(30, 1000);   // 30 cursor updates/sec
const chatLimiter = createRateLimiter(5, 2000);      // 5 messages / 2 sec

function currentRoomState(roomId) {
    return {
        pages: rooms[roomId].pages,
        chat: rooms[roomId].chat,
        users: rooms[roomId].users
    };
}

io.on('connection', (socket) => {
    // When a user joins a room
    socket.on('joinRoom', (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            const roomId = typeof data.roomId === 'string' ? data.roomId.trim() : '';
            const nickname = sanitizeNickname(data.nickname);

            // Basic validation for room ID format
            if (!/^\d{4}$/.test(roomId)) {
                socket.emit('joinError', 'Room ID must be a 4-digit code.');
                return;
            }
            if (!nickname) {
                socket.emit('joinError', 'Nickname cannot be empty.');
                return;
            }

            socket.join(roomId);
            socket.roomId = roomId;
            socket.nickname = nickname;

            // If the room doesn't exist, create it with one default page and empty chat
            if (!rooms[roomId]) {
                rooms[roomId] = {
                    users: {},
                    pages: [{ drawingActions: [] }], // Start with one blank page
                    chat: []
                };
            }

            // Add user to the room's user list
            rooms[roomId].users[socket.id] = { nickname, cursor: { x: 0, y: 0 } };

            // Send the entire room's current state to the new user (only on join)
            socket.emit('roomState', currentRoomState(roomId));

            // Notify others in the room about the new user
            socket.to(roomId).emit('userJoined', {
                id: socket.id,
                nickname,
                cursor: { x: 0, y: 0 }
            });

            // Send updated user list to all existing users in the room
            io.in(roomId).emit('updateUserList', rooms[roomId].users);
        } catch (err) {
            console.error('joinRoom error:', err);
        }
    });

    // When a user finishes a drawing stroke/shape/fill
    socket.on('drawingAction', (data) => {
        try {
            if (!drawingLimiter.isAllowed(socket.id)) return;
            const { roomId } = socket;
            if (!roomId || !rooms[roomId] || !data || typeof data.pageId !== 'number') return;

            const page = rooms[roomId].pages[data.pageId];
            if (!page || !data.action || typeof data.action.toolType !== 'string') return;
            if (page.drawingActions.length >= MAX_ACTIONS_PER_PAGE) {
                socket.emit('errorMessage', 'This page has reached its action limit. Try clearing it or starting a new page.');
                return;
            }

            // Tag the action with its author so undo can target the right stroke.
            // Preserve the client-generated id (used to reconcile undo across clients).
            const action = {
                ...data.action,
                id: isValidActionId(data.action.id) ? data.action.id : `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                socketId: socket.id
            };

            if (action.toolType === 'fill') {
                // Clear existing fill actions if a new one is applied
                page.drawingActions = page.drawingActions.filter(a => a.toolType !== 'fill');
                page.drawingActions.unshift(action);
            } else {
                page.drawingActions.push(action);
            }

            // Broadcast only to other clients; the sender already rendered locally.
            socket.to(roomId).emit('drawingAction', { pageId: data.pageId, action });
        } catch (err) {
            console.error('drawingAction error:', err);
        }
    });

    // When a user adds a new page
    socket.on('addPage', () => {
        try {
            const { roomId } = socket;
            if (!roomId || !rooms[roomId]) return;

            if (rooms[roomId].pages.length >= MAX_PAGES_PER_ROOM) {
                socket.emit('errorMessage', `This room already has the maximum of ${MAX_PAGES_PER_ROOM} pages.`);
                return;
            }

            const newPage = { drawingActions: [] };
            rooms[roomId].pages.push(newPage);
            const index = rooms[roomId].pages.length - 1;

            // Only send the new page, not the whole room state.
            io.in(roomId).emit('pageAdded', { page: newPage, index });
        } catch (err) {
            console.error('addPage error:', err);
        }
    });

    // When a user deletes a page
    socket.on('deletePage', (data) => {
        try {
            const { roomId } = socket;
            const pageId = data && data.pageId;
            if (!roomId || !rooms[roomId] || typeof pageId !== 'number') return;

            // Validation: page exists and it's not the last page
            if (rooms[roomId].pages[pageId] && rooms[roomId].pages.length > 1) {
                rooms[roomId].pages.splice(pageId, 1);
                io.in(roomId).emit('pageDeleted', { pageId });
            }
        } catch (err) {
            console.error('deletePage error:', err);
        }
    });

    // When a user performs an undo — only removes THEIR OWN last action on the page
    socket.on('undo', (data) => {
        try {
            const { roomId } = socket;
            const pageId = data && data.pageId;
            if (!roomId || !rooms[roomId] || typeof pageId !== 'number') return;

            const page = rooms[roomId].pages[pageId];
            if (!page) return;

            for (let i = page.drawingActions.length - 1; i >= 0; i--) {
                if (page.drawingActions[i].socketId === socket.id) {
                    const [removed] = page.drawingActions.splice(i, 1);
                    io.in(roomId).emit('actionRemoved', { pageId, actionId: removed.id });
                    return;
                }
            }
        } catch (err) {
            console.error('undo error:', err);
        }
    });

    // Handle clearing the current page
    socket.on('clearPage', (data) => {
        try {
            const { roomId } = socket;
            const pageId = data && data.pageId;
            if (!roomId || !rooms[roomId] || typeof pageId !== 'number') return;

            if (rooms[roomId].pages[pageId]) {
                rooms[roomId].pages[pageId].drawingActions = [];
                io.in(roomId).emit('pageCleared', { pageId });
            }
        } catch (err) {
            console.error('clearPage error:', err);
        }
    });

    // Handle chat messages
    socket.on('chatMessage', (message) => {
        try {
            if (!chatLimiter.isAllowed(socket.id)) return;
            const { roomId, nickname } = socket;
            if (!roomId || !rooms[roomId]) return;

            const clean = sanitizeChatMessage(message);
            if (!clean) return;

            const chatEntry = { nickname, message: clean, timestamp: Date.now() };
            rooms[roomId].chat.push(chatEntry);
            if (rooms[roomId].chat.length > MAX_CHAT_HISTORY) {
                rooms[roomId].chat.shift();
            }

            io.in(roomId).emit('newChatMessage', chatEntry);
        } catch (err) {
            console.error('chatMessage error:', err);
        }
    });

    // Handle cursor movements
    socket.on('cursorMove', (data) => {
        try {
            if (!cursorLimiter.isAllowed(socket.id)) return;
            const { roomId } = socket;
            if (!roomId || !rooms[roomId] || !rooms[roomId].users[socket.id]) return;
            if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return;

            rooms[roomId].users[socket.id].cursor = { x: data.x, y: data.y };
            socket.to(roomId).emit('cursorUpdate', { id: socket.id, x: data.x, y: data.y });
        } catch (err) {
            console.error('cursorMove error:', err);
        }
    });

    // When a user disconnects
    socket.on('disconnect', () => {
        try {
            const { roomId } = socket;
            if (roomId && rooms[roomId]) {
                // Remove user from the room's user list
                delete rooms[roomId].users[socket.id];

                // Notify others in the room about the user leaving
                io.in(roomId).emit('userLeft', socket.id);

                // If the room is empty, delete it from memory
                if (Object.keys(rooms[roomId].users).length === 0) {
                    delete rooms[roomId];
                } else {
                    // Otherwise, update the user list for remaining clients
                    io.in(roomId).emit('updateUserList', rooms[roomId].users);
                }
            }
            drawingLimiter.cleanup(socket.id);
            cursorLimiter.cleanup(socket.id);
            chatLimiter.cleanup(socket.id);
        } catch (err) {
            console.error('disconnect error:', err);
        }
    });
});

server.listen(PORT, () => console.log(`Server is live and running on http://localhost:${PORT}`));
