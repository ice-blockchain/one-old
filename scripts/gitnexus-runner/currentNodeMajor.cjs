'use strict';

// Returns the current Node major (e.g. 20 for v20.18.3). Pure read; never
// throws. Used by both bootstrap() and the post-stack-setup hook so we
// surface the upgrade hint at the earliest possible moment.
function currentNodeMajor() {
  const raw = process.versions && process.versions.node;
  if (typeof raw !== 'string') return null;
  const major = Number(raw.split('.')[0]);
  return Number.isFinite(major) ? major : null;
}

module.exports = { currentNodeMajor };
