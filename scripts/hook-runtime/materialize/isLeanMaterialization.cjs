'use strict';

function isLeanMaterialization(cwd, state) {
  if (state && (
    state.leanMode === false
    || state.contextMode === 'full'
    || state.tokenProfile === 'full'
  )) {
    return false;
  }
  return true;
}

module.exports = { isLeanMaterialization };
