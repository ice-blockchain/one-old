'use strict';

const { collectFileExtensions } = require('./collectFileExtensions.cjs');
const { collectTechnologies } = require('./collectTechnologies.cjs');
const { collectArchitectureComponents } = require('./collectArchitectureComponents.cjs');
const {
  detectInfrastructureVendor,
} = require('./_helpers.cjs');

function collectMetadata(cwd, state, reportId) {
  const fileExtensions = collectFileExtensions(cwd);
  return {
    report_id: reportId,
    technologies: collectTechnologies(cwd, state, fileExtensions),
    file_extensions: fileExtensions,
    architecture_components: collectArchitectureComponents(cwd, state),
    infrastructure_vendor: detectInfrastructureVendor(cwd),
  };
}

module.exports = { collectMetadata };
