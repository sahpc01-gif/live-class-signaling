const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});


io.on("connection", (socket) => {

    console.log("Client connected:", socket.id);

});


const PORT = process.env.PORT || 10000;

httpServer.listen(PORT, () => {
    console.log(
        "Signaling server running on port " + PORT
    );
});
