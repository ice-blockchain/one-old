'use strict';

function isTrafficOneDoctorCommand(command) {
  return /\bscripts\/doctor\.cjs\b/.test(String(command || ''));
}

module.exports = { isTrafficOneDoctorCommand };
