document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // --- DOM Element Selection ---
    const mainCanvas = document.getElementById('main-canvas');
    const ctx = mainCanvas.getContext('2d');
    const cursorLayer = document.getElementById('cursor-layer');

    const nicknameDisplay = document.getElementById('user-nickname-display');
    const roomNameDisplay = document.getElementById('room-name-display');
    const participantsList = document.getElementById('participants-list');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendChatBtn = document.getElementById('send-chat-btn');
    const copyInviteBtn = document.getElementById('copy-invite-btn');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');

    const toolButtons = document.querySelectorAll('.tool-btn');
    const pencilToolBtn = document.getElementById('pencil-tool');
    const eraserToolBtn = document.getElementById('eraser-tool');
    const shapeSquareToolBtn = document.getElementById('shape-square-tool');
    const shapeCircleToolBtn = document.getElementById('shape-circle-tool');
    const fillToolBtn = document.getElementById('fill-tool');

    const brushSizeSlider = document.getElementById('brush-size-slider');
    const undoBtn = document.getElementById('undo-btn');
    const clearPageBtn = document.getElementById('clear-page-btn');
    const colorPaletteContainer = document.getElementById('color-palette');

    const pageReviewContainer = document.getElementById('page-review-container');
    const pagePreviews = document.getElementById('page-previews');
    const addPageBtn = document.getElementById('add-page-btn');

    // --- State Management ---
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');
    const nickname = urlParams.get('nickname');

    // If someone lands here without a room/nickname (e.g. bookmarked link), bounce home.
    if (!roomId || !nickname) {
        window.location.href = '/';
        return;
    }

    // Display room info
    roomNameDisplay.textContent = `Room: ${roomId}`;
    nicknameDisplay.textContent = `You: ${nickname}`;

    let drawing = false;
    let currentStroke = []; // Stores individual points for current stroke/path
    let lastPos = { x: 0, y: 0 };
    let tool = 'pencil'; // 'pencil', 'eraser', 'square', 'circle', 'fill'
    let currentColor = '#000000';
    let currentBrushSize = 5;
    let hasJoinedOnce = false;

    let pages = []; // Stores history of drawing actions for each page
    let activePageIndex = 0;
    let remoteUsers = {}; // { socketId: { nickname: '...', cursor: {x,y}, element: div } }

    const availableColors = [
        '#000000', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#808080', '#FFFFFF',
        '#A37DF2', '#5D70F7', '#E84D7A', '#34C759', '#FF9500', '#5AC8FA', '#FF2D55', '#AF52DE', '#FF3B30'
    ];

    // --- Small utilities ---
    function generateActionId() {
        if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message; // textContent only — never trust message content
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('visible'));
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        }, 3200);
    }

    function hideLoadingOverlay() {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }

    function showLoadingOverlay(message) {
        if (!loadingOverlay) return;
        if (loadingText) loadingText.textContent = message;
        loadingOverlay.classList.remove('hidden');
    }

    // --- Canvas Setup & Resizing ---
    function resizeCanvas() {
        mainCanvas.width = mainCanvas.offsetWidth;
        mainCanvas.height = mainCanvas.offsetHeight;
        redrawActivePage();
        redrawAllPreviews();
    }
    window.addEventListener('resize', resizeCanvas);

    // --- Drawing Logic ---
    function getMousePos(e) {
        const rect = mainCanvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function drawAction(action, targetCtx = ctx) {
        // Handle 'fill' action type
        if (action.toolType === 'fill') {
            targetCtx.fillStyle = action.color;
            targetCtx.fillRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
            return;
        }

        targetCtx.beginPath();
        targetCtx.strokeStyle = (action.toolType === 'eraser') ? '#FFFFFF' : action.color;
        targetCtx.lineWidth = action.size;
        targetCtx.lineCap = 'round';
        targetCtx.lineJoin = 'round';

        if (action.toolType === 'pencil' || action.toolType === 'eraser') {
            if (action.points && action.points.length > 1) {
                targetCtx.moveTo(action.points[0].x, action.points[0].y);
                for (let i = 1; i < action.points.length; i++) {
                    targetCtx.lineTo(action.points[i].x, action.points[i].y);
                }
            }
        } else if (action.toolType === 'square') {
            targetCtx.rect(action.x0, action.y0, action.x1 - action.x0, action.y1 - action.y0);
        } else if (action.toolType === 'circle') {
            const radius = Math.sqrt(Math.pow(action.x1 - action.x0, 2) + Math.pow(action.y1 - action.y0, 2)) / 2;
            const centerX = action.x0 + (action.x1 - action.x0) / 2;
            const centerY = action.y0 + (action.y1 - action.y0) / 2;
            targetCtx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        }
        targetCtx.stroke();
    }

    function emitFillAction() {
        const fillAction = {
            id: generateActionId(),
            toolType: 'fill',
            color: currentColor,
            timestamp: Date.now()
        };
        pages[activePageIndex].drawingActions = pages[activePageIndex].drawingActions.filter(a => a.toolType !== 'fill');
        pages[activePageIndex].drawingActions.unshift(fillAction);
        redrawActivePage();
        redrawCurrentPreview();
        socket.emit('drawingAction', { pageId: activePageIndex, action: fillAction });
    }

    function startDrawing(e) {
        if (e.target.id !== 'main-canvas') return;
        drawing = true;
        lastPos = getMousePos(e);
        currentStroke = [{ x: lastPos.x, y: lastPos.y }];

        if (tool === 'fill') {
            emitFillAction();
            drawing = false;
        }
    }

    function stopDrawing() {
        if (!drawing) return;
        drawing = false;

        if (tool === 'pencil' || tool === 'eraser') {
            if (currentStroke.length > 1) {
                const action = {
                    id: generateActionId(),
                    toolType: tool,
                    points: currentStroke,
                    color: currentColor,
                    size: currentBrushSize
                };
                pages[activePageIndex].drawingActions.push(action);
                socket.emit('drawingAction', { pageId: activePageIndex, action });
                redrawCurrentPreview();
            }
        } else if (tool === 'square' || tool === 'circle') {
            if (currentStroke.length > 0) {
                const startPoint = currentStroke[0];
                const endPoint = lastPos;
                const action = {
                    id: generateActionId(),
                    x0: startPoint.x, y0: startPoint.y,
                    x1: endPoint.x, y1: endPoint.y,
                    color: currentColor, size: currentBrushSize, toolType: tool
                };
                pages[activePageIndex].drawingActions.push(action);
                socket.emit('drawingAction', { pageId: activePageIndex, action });
                redrawCurrentPreview();
            }
        }
        currentStroke = [];
    }

    let lastCursorEmit = 0;
    const CURSOR_EMIT_INTERVAL_MS = 40; // throttle to ~25 updates/sec

    function drawOnMove(e) {
        if (e.target.id === 'main-canvas') {
            const pos = getMousePos(e);
            const now = Date.now();
            if (now - lastCursorEmit >= CURSOR_EMIT_INTERVAL_MS) {
                socket.emit('cursorMove', { x: pos.x, y: pos.y });
                lastCursorEmit = now;
            }
        }

        if (!drawing || tool === 'fill') return;

        const currentPos = getMousePos(e);

        if (tool === 'pencil' || tool === 'eraser') {
            currentStroke.push({ x: currentPos.x, y: currentPos.y });
            const actionSegment = {
                toolType: tool,
                points: [lastPos, currentPos],
                color: currentColor,
                size: currentBrushSize
            };
            drawAction(actionSegment);
            lastPos = currentPos;
        } else if (tool === 'square' || tool === 'circle') {
            redrawActivePage();
            const startPoint = currentStroke[0];
            const tempAction = {
                x0: startPoint.x, y0: startPoint.y,
                x1: currentPos.x, y1: currentPos.y,
                color: currentColor, size: currentBrushSize, toolType: tool
            };
            drawAction(tempAction);
            lastPos = currentPos;
        }
    }

    // --- Touch support (mobile/tablet) ---
    function touchToMouseLike(touch, target) {
        return { target, clientX: touch.clientX, clientY: touch.clientY };
    }

    mainCanvas.addEventListener('touchstart', (e) => {
        if (e.target.id !== 'main-canvas') return;
        e.preventDefault();
        const touch = e.touches[0];
        startDrawing(touchToMouseLike(touch, e.target));
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
        if (!drawing) return;
        e.preventDefault();
        const touch = e.touches[0];
        drawOnMove(touchToMouseLike(touch, e.target));
    }, { passive: false });

    document.addEventListener('touchend', () => stopDrawing());
    document.addEventListener('touchcancel', () => stopDrawing());

    // --- UI Rendering ---
    function renderUI() {
        renderColorPalette();
        renderPagePreviews();
        setupToolButtons();
        updateParticipantsList();
    }

    function renderColorPalette() {
        colorPaletteContainer.innerHTML = '';
        availableColors.forEach(c => {
            const swatch = document.createElement('div');
            swatch.className = 'color-swatch';
            if (c === currentColor) swatch.classList.add('active');
            swatch.style.backgroundColor = c;
            swatch.title = c;
            swatch.addEventListener('click', () => {
                currentColor = c;
                renderColorPalette();
            });
            colorPaletteContainer.appendChild(swatch);
        });
    }

    function renderPagePreviews() {
        pagePreviews.innerHTML = '';

        pages.forEach((page, index) => {
            const previewItem = document.createElement('div');
            previewItem.className = 'page-preview-item';
            if (index === activePageIndex) previewItem.classList.add('active');

            const previewCanvas = document.createElement('canvas');
            previewCanvas.className = 'page-preview-canvas';
            previewCanvas.width = 60;
            previewCanvas.height = 34;
            previewItem.appendChild(previewCanvas);

            if (pages.length > 1) {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'delete-page-icon';
                deleteBtn.textContent = '\u00d7';
                deleteBtn.title = 'Delete Page';
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm('Are you sure you want to delete this page?')) {
                        socket.emit('deletePage', { pageId: index });
                    }
                };
                previewItem.appendChild(deleteBtn);
            }

            previewItem.onclick = () => switchPage(index);
            pagePreviews.appendChild(previewItem);
        });

        redrawAllPreviews();
    }

    function setupToolButtons() {
        toolButtons.forEach(btn => {
            btn.onclick = () => {
                if (btn === fillToolBtn) {
                    emitFillAction();
                    return;
                }

                toolButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (btn === pencilToolBtn) tool = 'pencil';
                else if (btn === eraserToolBtn) tool = 'eraser';
                else if (btn === shapeSquareToolBtn) tool = 'square';
                else if (btn === shapeCircleToolBtn) tool = 'circle';
            };
        });

        undoBtn.onclick = () => {
            if (pages[activePageIndex] && pages[activePageIndex].drawingActions.length > 0) {
                socket.emit('undo', { pageId: activePageIndex });
            }
        };

        clearPageBtn.onclick = () => {
            if (confirm('Are you sure you want to clear this entire page? This cannot be undone.')) {
                socket.emit('clearPage', { pageId: activePageIndex });
            }
        };

        brushSizeSlider.oninput = (e) => {
            currentBrushSize = parseInt(e.target.value, 10);
        };

        addPageBtn.onclick = () => socket.emit('addPage');
    }

    // --- Redrawing Logic ---
    function redrawActivePage() {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, mainCanvas.width, mainCanvas.height);

        if (pages[activePageIndex]) {
            pages[activePageIndex].drawingActions.forEach(action => drawAction(action));
        }
    }
    function redrawAllPreviews() { pages.forEach((p, i) => redrawPreviewByIndex(i)); }
    function redrawCurrentPreview() { redrawPreviewByIndex(activePageIndex); }
    function redrawPreviewByIndex(index) {
        const previewItem = pagePreviews.querySelectorAll('.page-preview-item')[index];
        if (!previewItem) return;

        const previewCanvas = previewItem.querySelector('.page-preview-canvas');
        const previewCtx = previewCanvas.getContext('2d');

        previewCtx.fillStyle = '#FFFFFF';
        previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

        const scaleX = previewCanvas.width / mainCanvas.width;
        const scaleY = previewCanvas.height / mainCanvas.height;

        if (pages[index]) {
            pages[index].drawingActions.forEach(action => {
                const scaledAction = { ...action };

                if (action.toolType === 'pencil' || action.toolType === 'eraser') {
                    scaledAction.points = action.points.map(p => ({ x: p.x * scaleX, y: p.y * scaleY }));
                } else if (action.toolType === 'square' || action.toolType === 'circle') {
                    scaledAction.x0 = action.x0 * scaleX;
                    scaledAction.y0 = action.y0 * scaleY;
                    scaledAction.x1 = action.x1 * scaleX;
                    scaledAction.y1 = action.y1 * scaleY;
                }

                scaledAction.size = Math.max(0.5, (action.size || 1) * Math.min(scaleX, scaleY) * 0.7);

                drawAction(scaledAction, previewCtx);
            });
        }
    }

    function switchPage(index) {
        if (index === activePageIndex) return;
        activePageIndex = index;
        renderPagePreviews();
        redrawActivePage();
    }

    // --- Participants List ---
    function updateParticipantsList() {
        participantsList.innerHTML = '';
        for (const id in remoteUsers) {
            if (id === socket.id) continue;
            const user = remoteUsers[id];
            const item = document.createElement('div');
            item.className = 'participant-item';
            const avatar = document.createElement('div');
            avatar.className = 'participant-avatar';
            avatar.textContent = (user.nickname || '?').charAt(0).toUpperCase();
            const nameSpan = document.createElement('span');
            nameSpan.textContent = user.nickname;
            item.appendChild(avatar);
            item.appendChild(nameSpan);
            participantsList.appendChild(item);
        }
    }

    // --- Chat Functions ---
    // IMPORTANT: always build chat DOM with textContent, never innerHTML,
    // so nicknames/messages from other users can never inject markup or scripts.
    function addChatMessage(data) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';

        const strong = document.createElement('strong');
        const displayName = (data.nickname === nickname) ? 'You' : data.nickname;
        strong.textContent = `${displayName}:`;

        const span = document.createElement('span');
        span.textContent = ` ${data.message}`;

        messageDiv.appendChild(strong);
        messageDiv.appendChild(span);
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function sendChatMessage() {
        const message = chatInput.value.trim();
        if (message) {
            socket.emit('chatMessage', message);
            addChatMessage({ nickname, message });
            chatInput.value = '';
        }
    }
    sendChatBtn.addEventListener('click', sendChatMessage);
    chatInput.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });

    // --- Invite link ---
    if (copyInviteBtn) {
        copyInviteBtn.addEventListener('click', async () => {
            const inviteUrl = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(inviteUrl);
                    showToast('Invite link copied to clipboard!', 'success');
                } else {
                    throw new Error('Clipboard API unavailable');
                }
            } catch (err) {
                showToast('Could not copy automatically. Room code: ' + roomId, 'error');
            }
        });
    }

    // --- Live Cursors ---
    // Built with createElement + textContent (never innerHTML) to avoid
    // injecting markup via another user's nickname.
    function updateCursorPosition(id, x, y) {
        const cursorDiv = remoteUsers[id]?.element;
        if (cursorDiv) {
            cursorDiv.style.left = `${x}px`;
            cursorDiv.style.top = `${y}px`;
        }
    }

    function addCursor(id, remoteNickname, x, y) {
        if (id === socket.id || remoteUsers[id]?.element) return;

        const cursorDiv = document.createElement('div');
        cursorDiv.className = 'remote-cursor';
        cursorDiv.dataset.userId = id;

        const pointer = document.createElement('div');
        pointer.className = 'cursor-pointer';

        const label = document.createElement('div');
        label.className = 'cursor-name';
        label.textContent = remoteNickname;

        cursorDiv.appendChild(pointer);
        cursorDiv.appendChild(label);
        cursorDiv.style.left = `${x}px`;
        cursorDiv.style.top = `${y}px`;
        cursorLayer.appendChild(cursorDiv);

        if (!remoteUsers[id]) remoteUsers[id] = { nickname: remoteNickname, cursor: { x, y } };
        remoteUsers[id].element = cursorDiv;
    }

    function removeCursor(id) {
        if (remoteUsers[id]?.element) {
            remoteUsers[id].element.remove();
            delete remoteUsers[id].element;
        }
    }

    function syncUserList(updatedUsers) {
        const oldRemoteUsers = { ...remoteUsers };
        remoteUsers = {};

        for (const id in updatedUsers) {
            if (id === socket.id) continue;
            remoteUsers[id] = { ...updatedUsers[id] };
            if (oldRemoteUsers[id] && oldRemoteUsers[id].element) {
                remoteUsers[id].element = oldRemoteUsers[id].element;
            } else {
                addCursor(id, updatedUsers[id].nickname, updatedUsers[id].cursor.x, updatedUsers[id].cursor.y);
            }
        }

        for (const id in oldRemoteUsers) {
            if (!remoteUsers[id] && id !== socket.id) {
                removeCursor(id);
            }
        }
        updateParticipantsList();
    }

    // --- Socket.IO Handlers ---
    socket.on('connect', () => {
        if (hasJoinedOnce) {
            showLoadingOverlay('Reconnected. Syncing room...');
        }
        socket.emit('joinRoom', { roomId, nickname });
    });

    socket.on('disconnect', () => {
        showLoadingOverlay('Connection lost. Reconnecting...');
    });

    socket.on('joinError', (message) => {
        showToast(message, 'error');
        setTimeout(() => { window.location.href = '/'; }, 1500);
    });

    socket.on('errorMessage', (message) => {
        showToast(message, 'error');
    });

    socket.on('roomState', (data) => {
        hasJoinedOnce = true;
        pages = data.pages;
        chatMessages.innerHTML = '';
        data.chat.forEach(msg => addChatMessage(msg));

        syncUserList(data.users);

        if (activePageIndex >= pages.length) activePageIndex = pages.length - 1;
        if (activePageIndex < 0) activePageIndex = 0;
        renderUI();
        resizeCanvas();
        hideLoadingOverlay();
    });

    socket.on('drawingAction', (data) => {
        if (pages[data.pageId]) {
            if (data.action.toolType === 'fill') {
                pages[data.pageId].drawingActions = pages[data.pageId].drawingActions.filter(a => a.toolType !== 'fill');
                pages[data.pageId].drawingActions.unshift(data.action);
            } else {
                pages[data.pageId].drawingActions.push(data.action);
            }

            if (data.pageId === activePageIndex) {
                redrawActivePage();
            }
            redrawPreviewByIndex(data.pageId);
        }
    });

    socket.on('pageAdded', ({ page, index }) => {
        pages[index] = page;
        renderPagePreviews();
        switchPage(index);
    });

    socket.on('pageDeleted', ({ pageId }) => {
        pages.splice(pageId, 1);
        if (activePageIndex >= pages.length) activePageIndex = pages.length - 1;
        renderPagePreviews();
        redrawActivePage();
    });

    socket.on('pageCleared', ({ pageId }) => {
        if (pages[pageId]) {
            pages[pageId].drawingActions = [];
            if (pageId === activePageIndex) redrawActivePage();
            redrawPreviewByIndex(pageId);
        }
    });

    socket.on('actionRemoved', ({ pageId, actionId }) => {
        if (pages[pageId]) {
            pages[pageId].drawingActions = pages[pageId].drawingActions.filter(a => a.id !== actionId);
            if (pageId === activePageIndex) redrawActivePage();
            redrawPreviewByIndex(pageId);
        }
    });

    socket.on('newChatMessage', (data) => {
        if (data.nickname !== nickname) {
            addChatMessage(data);
        }
    });

    socket.on('cursorUpdate', (data) => {
        if (remoteUsers[data.id]) {
            remoteUsers[data.id].cursor = { x: data.x, y: data.y };
            updateCursorPosition(data.id, data.x, data.y);
        }
    });

    socket.on('userJoined', (data) => {
        if (data.id !== socket.id) {
            remoteUsers[data.id] = { nickname: data.nickname, cursor: data.cursor };
            addCursor(data.id, data.nickname, data.cursor.x, data.cursor.y);
            updateParticipantsList();
            addChatMessage({ nickname: 'System', message: `${data.nickname} joined the room.` });
        }
    });

    socket.on('userLeft', (id) => {
        if (remoteUsers[id]) {
            addChatMessage({ nickname: 'System', message: `${remoteUsers[id].nickname} left the room.` });
            removeCursor(id);
            delete remoteUsers[id];
            updateParticipantsList();
        }
    });

    socket.on('updateUserList', (updatedUsers) => {
        syncUserList(updatedUsers);
    });

    // --- Initial Setup ---
    mainCanvas.addEventListener('mousedown', startDrawing);
    document.addEventListener('mouseup', stopDrawing);
    document.addEventListener('mousemove', drawOnMove);
});
