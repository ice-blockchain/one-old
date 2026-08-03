const express = require('express');
const { ordersRouter } = require('./routes/orders');
const { statusRouter } = require('./routes/status');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', ordersRouter);
  app.use('/api/status', statusRouter);
  return app;
}

module.exports = { createApp };
