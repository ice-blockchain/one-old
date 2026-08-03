const assert = require('node:assert');
const { createApp } = require('../server/app');

assert.ok(typeof createApp === 'function');
console.log('ok');
