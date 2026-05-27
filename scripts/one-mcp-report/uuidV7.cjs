'use strict';

const crypto = require('crypto');

function uuidV7(date = new Date()) {
  const millis = BigInt(date.getTime()).toString(16).padStart(12, '0').slice(-12);
  const random = crypto.randomBytes(10);
  const randA = (((random[0] << 8) | random[1]) & 0x0fff).toString(16).padStart(3, '0');
  const variant = ((random[2] & 0x3f) | 0x80).toString(16).padStart(2, '0');
  const tail = Buffer.from(random.subarray(4, 10)).toString('hex');
  return `${millis.slice(0, 8)}-${millis.slice(8)}-7${randA}-${variant}${random[3].toString(16).padStart(2, '0')}-${tail}`;
}

module.exports = { uuidV7 };
