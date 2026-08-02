const { Router } = require('express');
const { Order } = require('../models/order');

const ordersRouter = Router();

ordersRouter.get('/', async (_req, res) => {
  const orders = await Order.find().limit(50).lean();
  res.json({ orders });
});

module.exports = { ordersRouter };
