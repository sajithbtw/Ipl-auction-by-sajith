
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;
const PURSE = 120;
const MAX_TEAMS = 10;

const FRANCHISES = [
  "CSK", "MI", "RCB", "KKR", "SRH",
  "RR", "DC", "PBKS", "GT", "LSG"
];

const rooms = new Map();

function generateCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function getPublicRooms() {
  return [...rooms.values()]
    .filter(r => !r.isPrivate && r.status === "waiting")
    .map(r => ({
      code: r.code,
      players: r.teams.length,
      maxTeams: MAX_TEAMS
    }));
}

function safeRoom(room) {
  return {
    code: room.code,
    host: room.host,
    status: room.status,
    isPrivate: room.isPrivate,
    teams: room.teams.map(t => ({
      name: t.name,
      purse: t.purse,
      squad: t.squad,
      connected: t.connected
    })),
    currentPlayer: room.currentPlayer,
    currentBid: room.currentBid,
    highestBidder: room.highestBidder,
    players: room.players,
    settings: room.settings
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room-updated", safeRoom(room));
  io.emit("public-rooms", getPublicRooms());
}

io.on("connection", socket => {
  socket.emit("public-rooms", getPublicRooms());

  // CREATE ROOM
  socket.on("create-room", (data = {}, callback = () => {}) => {
    const code = generateCode();

    const room = {
      code,
      host: socket.id,
      isPrivate: Boolean(data.privateRoom),
      status: "waiting",
      teams: [],
      players: [],
      currentPlayer: null,
      currentBid: 0,
      highestBidder: null,
      soldPlayers: [],
      unsoldPlayers: [],
      settings: {
        purse: PURSE,
        maxTeams: MAX_TEAMS,
        increment: 0.25
      }
    };

    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);

    callback({
      success: true,
      code,
      room: safeRoom(room)
    });

    broadcastRoom(room);
  });

  // JOIN ROOM
  socket.on("join-room", (data = {}, callback = () => {}) => {
    const code = String(data.code || "").toUpperCase();
    const room = rooms.get(code);

    if (!room)
      return callback({ success: false, message: "Room not found." });

    if (room.status !== "waiting")
      return callback({ success: false, message: "Auction already started." });

    if (room.teams.length >= MAX_TEAMS)
      return callback({ success: false, message: "Room is full." });

    if (!FRANCHISES.includes(data.teamName))
      return callback({ success: false, message: "Invalid franchise." });

    if (room.teams.some(t => t.name === data.teamName))
      return callback({ success: false, message: "Franchise already taken." });

    const team = {
      id: socket.id,
      name: data.teamName,
      purse: PURSE,
      squad: [],
      connected: true
    };

    room.teams.push(team);
    room.players.push({
      id: socket.id,
      manager: String(data.managerName || "Manager").slice(0, 20),
      teamName: data.teamName
    });

    socket.data.roomCode = code;
    socket.join(code);

    callback({ success: true, room: safeRoom(room) });
    broadcastRoom(room);
  });

  // START AUCTION
  socket.on("start-auction", (data = {}, callback = () => {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room)
      return callback({ success: false, message: "Room not found." });

    if (room.host !== socket.id)
      return callback({ success: false, message: "Only the host can start." });

    if (room.teams.length < 2)
      return callback({ success: false, message: "Need at least 2 teams." });

    room.status = "auction";
    broadcastRoom(room);

    callback({ success: true });
  });

  // SET CURRENT PLAYER — HOST
  socket.on("next-player", (data = {}, callback = () => {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room || room.host !== socket.id)
      return callback({ success: false, message: "Host only." });

    if (room.currentPlayer)
      return callback({ success: false, message: "Finish current bidding first." });

    const player = data.player;

    if (!player || !player.name || !player.basePrice)
      return callback({ success: false, message: "Invalid player." });

    room.currentPlayer = player;
    room.currentBid = Number(player.basePrice);
    room.highestBidder = null;

    broadcastRoom(room);
    callback({ success: true });
  });

  // PLACE BID
  socket.on("place-bid", (data = {}, callback = () => {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room || room.status !== "auction")
      return callback({ success: false, message: "Auction is not active." });

    const team = room.teams.find(t => t.id === socket.id);

    if (!team)
      return callback({ success: false, message: "You are a spectator." });

    if (!room.currentPlayer)
      return callback({ success: false, message: "No active player." });

    const amount = Number(data.amount);
    const increment = room.settings.increment;

    if (!Number.isFinite(amount) || amount < room.currentBid + increment - 0.001)
      return callback({ success: false, message: "Bid is too low." });

    if (amount > team.purse)
      return callback({ success: false, message: "Insufficient purse." });

    room.currentBid = amount;
    room.highestBidder = socket.id;

    io.to(room.code).emit("bid-updated", {
      amount,
      teamName: team.name,
      bidderId: team.id
    });

    broadcastRoom(room);
    callback({ success: true });
  });

  // SOLD — HOST
  socket.on("sell-player", (data = {}, callback = () => {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room || room.host !== socket.id)
      return callback({ success: false, message: "Host only." });

    if (!room.currentPlayer)
      return callback({ success: false, message: "No active player." });

    if (!room.highestBidder)
      return callback({ success: false, message: "No bids placed." });

    const team = room.teams.find(t => t.id === room.highestBidder);
    const player = room.currentPlayer;

    if (!team || team.purse < room.currentBid)
      return callback({ success: false, message: "Invalid winning bid." });

    team.purse = +(team.purse - room.currentBid).toFixed(2);
    team.squad.push({
      ...player,
      soldPrice: room.currentBid
    });

    room.soldPlayers.push(player.name);
    room.currentPlayer = null;
    room.currentBid = 0;
    room.highestBidder = null;

    io.to(room.code).emit("player-sold", {
      player: player.name,
      teamName: team.name
    });

    broadcastRoom(room);
    callback({ success: true });
  });

  // UNSOLD — HOST
  socket.on("unsold-player", (data = {}, callback = () => {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room || room.host !== socket.id)
      return callback({ success: false, message: "Host only." });

    if (!room.currentPlayer)
      return callback({ success: false, message: "No active player." });

    room.unsoldPlayers.push(room.currentPlayer.name);
    room.currentPlayer = null;
    room.currentBid = 0;
    room.highestBidder = null;

    broadcastRoom(room);
    callback({ success: true });
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room) return;

    const team = room.teams.find(t => t.id === socket.id);
    if (team) team.connected = false;

    broadcastRoom(room);
  });
});

app.get("/api/rooms", (req, res) => {
  res.json(getPublicRooms());
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", game: "IPL Auction Arena" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`IPL Auction Arena running on port ${PORT}`);
});
              
