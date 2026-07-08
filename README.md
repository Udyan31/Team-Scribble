# 🎨 TeamScribble — Real-Time Collaborative Whiteboard

A real-time collaborative whiteboard built with Node.js, Express, and Socket.IO. Multiple people can join a shared canvas, draw together, chat, and organize ideas across multiple pages — all synced live.

**Live Demo:** https://teamscribble.onrender.com/

---

## ✨ Key Features

- **Real-time collaboration** — drawing actions, cursor movement, and chat sync instantly across everyone in the room.
- **Multi-user cursors** — see each participant's cursor and nickname moving live on the canvas.
- **Room-based sessions** — join or create a room with a 4-digit code, or share a one-click invite link.
- **Drawing tools** — pencil, eraser, rectangle, circle, fill/paint bucket, full color palette, adjustable brush size.
- **Multi-page canvas** — add/delete pages, each with its own independent drawing history and thumbnail preview.
- **Per-user undo** — undo only removes *your own* last stroke, never a collaborator's.
- **Integrated chat** with join/leave system messages.
- **Live participant list**.
- **Touch support** — draw from a phone or tablet, not just with a mouse.
- **Connection status feedback** — a loading/reconnecting overlay and toast notifications instead of blocking `alert()` popups.

---

## 🛠️ Tech Stack

- **Front-end:** HTML5, CSS3 (Flexbox, responsive breakpoints), vanilla JavaScript (ES6+), Socket.IO client
- **Back-end:** Node.js, Express, Socket.IO (WebSocket transport)
- **Deployment:** Render

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/en/) v18 or later
- [Git](https://git-scm.com/)

### Installation & Setup

```sh
git clone https://github.com/Udyan31/TeamScribble.git
cd TeamScribble
npm install
npm start
```

Then open `http://localhost:3000` in your browser. Open a couple of tabs (or share a room code with a friend) to see the real-time sync in action.

The server reads `PORT` from the environment if set, otherwise it defaults to `3000`.

---

## 🔐 Security & Data Handling Notes

Read this before treating TeamScribble as more than a demo/portfolio project:

- **Rooms are not private, only obscure.** A room is just a 4-digit numeric code (10,000 possibilities) with no password or authentication. Anyone who knows or guesses the code can join. Don't put anything sensitive on a board.
- **Everything is stored in memory only.** There is no database. Restarting the server (or a redeploy) permanently wipes every room, drawing, and chat log. Rooms are also deleted automatically once everyone leaves.
- **User-generated content is escaped at render time.** Chat messages and nicknames are always inserted into the DOM via `textContent`/`createElement` — never `innerHTML` — so they can't inject scripts or markup. Message length and nickname length are also capped, both client- and server-side.
- **Basic rate limiting** is applied per-connection on drawing actions, cursor updates, and chat messages to prevent a single client from flooding a room.
- **Pages and per-page action history are capped** (20 pages per room, 3,000 actions per page; oldest chat messages roll off after 100) to keep memory use and payload size bounded on long-running rooms.

---

## 💡 Known Limitations / Roadmap

- No authentication or persistent accounts — anyone with the room code can join.
- No database — nothing survives a server restart.
- No text tool, straight-line tool, or image upload yet.
- No "browse public rooms" lobby.
- Scaling beyond a single server process would need a shared store (e.g. Redis) for Socket.IO room state, since everything currently lives in one process's memory.

Contributions and issues are welcome if you'd like to help tackle any of the above.

---

## License

MIT — see [LICENSE](LICENSE).
