"use strict";
// src/runners/one-mcp-report/collectMetadata.ts
// The exact anonymous metadata payload sent to one-mcp: report_id, technologies,
// file_extensions, architecture_components, infrastructure_vendor — and NOTHING
// else (no source, paths, URLs, names, or PII). Ported 1:1 from
// one-mcp-report/collectMetadata.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectMetadata = collectMetadata;
const collectArchitectureComponents_1 = require("./collectArchitectureComponents");
const collectFileExtensions_1 = require("./collectFileExtensions");
const collectTechnologies_1 = require("./collectTechnologies");
const lib_1 = require("./lib");
function collectMetadata(cwd, state, reportId) {
    const fileExtensions = (0, collectFileExtensions_1.collectFileExtensions)(cwd);
    return {
        report_id: reportId,
        technologies: (0, collectTechnologies_1.collectTechnologies)(cwd, state, fileExtensions),
        file_extensions: fileExtensions,
        architecture_components: (0, collectArchitectureComponents_1.collectArchitectureComponents)(cwd, state),
        infrastructure_vendor: (0, lib_1.detectInfrastructureVendor)(cwd),
    };
}
