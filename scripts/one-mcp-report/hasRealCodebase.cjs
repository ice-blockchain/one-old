'use strict';

const fs = require('fs');
const path = require('path');

function hasRealCodebase(cwd) {
  const directMarkers = [
    'package.json',
    'go.mod',
    'Cargo.toml',
    'pyproject.toml',
    'pom.xml',
    'build.gradle',
    'pubspec.yaml',
    'Package.swift',
  ];
  if (directMarkers.some((name) => fs.existsSync(path.join(cwd, name)))) return true;

  const workspaceDirs = ['apps', 'packages', 'src', 'app', 'pages', 'supabase'];
  return workspaceDirs.some((name) => fs.existsSync(path.join(cwd, name)));
}

module.exports = { hasRealCodebase };
