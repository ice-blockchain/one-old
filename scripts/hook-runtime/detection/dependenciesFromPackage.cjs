'use strict';

function dependenciesFromPackage(pkg) {
  return {
    ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}),
    ...(pkg.devDependencies && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {}),
  };
}

module.exports = { dependenciesFromPackage };
