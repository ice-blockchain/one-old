'use strict';

const { loadPackageJson } = require('./loadPackageJson.cjs');
const { dependenciesFromPackage } = require('./dependenciesFromPackage.cjs');
const { countSourceFiles } = require('./countSourceFiles.cjs');

function detectMode(cwd) {
  const pkg = loadPackageJson(cwd);
  const deps = dependenciesFromPackage(pkg);
  const fileCount = countSourceFiles(cwd);

  if (fileCount <= 5) {
    return 'new-project';
  }
  if (deps['@supabase/supabase-js'] || deps['@supabase/ssr']) {
    return 'existing-with-supabase';
  }
  return 'existing-codebase';
}

module.exports = { detectMode };
