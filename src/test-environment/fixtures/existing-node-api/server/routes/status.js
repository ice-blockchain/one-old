const { Router } = require('express');

const statusRouter = Router();

statusRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

module.exports = { statusRouter };
