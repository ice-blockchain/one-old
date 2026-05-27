'use strict';

function validReportId(value) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(String(value || '').trim());
}

module.exports = { validReportId };
