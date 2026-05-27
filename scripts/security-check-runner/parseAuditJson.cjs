'use strict';

function parseAuditJson(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.metadata?.vulnerabilities) {
      return {
        parsed: true,
        high: Number(parsed.metadata.vulnerabilities.high || 0),
        critical: Number(parsed.metadata.vulnerabilities.critical || 0),
      };
    }
    if (Array.isArray(parsed.vulnerabilities)) {
      return {
        parsed: true,
        high: parsed.vulnerabilities.filter((item) => item.severity === 'high').length,
        critical: parsed.vulnerabilities.filter((item) => item.severity === 'critical').length,
      };
    }
    if (parsed.advisories && typeof parsed.advisories === 'object') {
      const values = Object.values(parsed.advisories);
      return {
        parsed: true,
        high: values.filter((item) => item.severity === 'high').length,
        critical: values.filter((item) => item.severity === 'critical').length,
      };
    }
  } catch {
    // fall through
  }
  return { parsed: false, high: 0, critical: 0 };
}

module.exports = { parseAuditJson };
