const { WebSocketServer } = require('ws');

function attachFeed(server) {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello' }));
  });
  return wss;
}

module.exports = { attachFeed };
