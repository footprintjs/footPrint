/**
 * scopeLog - Logging utilities for pipeline execution
 * 
 * WHY: Provides structured logging for pipeline stages with consistent formatting.
 * Logs include pipeline ID, stage name, path, and key-value pairs.
 * 
 * DESIGN: Wraps the logger with stage-aware context and also records to
 * the stage's debug metadata for later inspection.
 */

import { logger } from '../utils/logger';
import { StageContext } from '../core/memory/StageContext';

const consoleLog = (
  localScope: StageContext,
  stageName: string,
  path: string[],
  key: string,
  value: unknown,
  reset?: boolean,
) => {
  if (reset) {
    localScope.setLog(key, value, path);
  } else {
    localScope.addLog(key, value, path);
  }
  logger.debug(
    `PIPELINE ID: [${localScope.pipelineId}] STAGE: [${stageName}] PATH: [${path}] ${key} = ${JSON.stringify(value)} `,
  );
};

const consoleError = (
  localScope: StageContext,
  stageName: string,
  path: string[],
  key: string,
  value: unknown,
  reset?: boolean,
) => {
  localScope.addError(key, value, path);
};

const consoleMetric = (
  localScope: StageContext,
  stageName: string,
  path: string[],
  key: string,
  value: unknown,
  reset?: boolean,
) => {
  if (reset) {
    localScope.setMetric(key, value, path);
  } else {
    localScope.addMetric(key, value, path);
  }
  logger.debug(
    `METRIC: PIPELINE ID: [${localScope.pipelineId}] STAGE: [${stageName}] PATH: [${path}] ${key} = ${JSON.stringify(
      value,
    )} `,
  );
};

const consoleEval = (
  localScope: StageContext,
  stageName: string,
  path: string[],
  key: string,
  value: unknown,
  reset?: boolean,
) => {
  if (reset) {
    localScope.setEval(key, value, path);
  } else {
    localScope.addEval(key, value, path);
  }
  logger.debug(
    `EVAL: PIPELINE ID: [${localScope.pipelineId}] STAGE: [${stageName}] PATH: [${path}] ${key} = ${JSON.stringify(
      value,
    )} `,
  );
};

export const treeConsole = {
  log: consoleLog,
  error: consoleError,
  metric: consoleMetric,
  eval: consoleEval,
};
