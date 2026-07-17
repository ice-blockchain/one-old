import {
  ONE_MCP_OPERATOR_CAS_SQL_FILE,
  ONE_MCP_OPERATOR_MANIFEST_FILE,
} from '../../config/one-mcp';
import type { GenRun } from '../lib/run';
import {
  oneMcpOperatorCasSql,
  oneMcpOperatorManifest,
} from '../sources/one-mcp-operator';

export function emitOneMcpOperatorArtifacts(run: GenRun): void {
  const manifest = oneMcpOperatorManifest();
  run.json(ONE_MCP_OPERATOR_MANIFEST_FILE, manifest);
  run.file(ONE_MCP_OPERATOR_CAS_SQL_FILE, oneMcpOperatorCasSql(manifest));
}
