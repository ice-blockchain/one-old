'use strict';

function projectSlugFromCwd(cwd) {
  return cwd.replace(/\//g, '-');
}

module.exports = { projectSlugFromCwd };
