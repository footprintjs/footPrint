import { logger } from '../logger';
import { StageContext } from './StageContext';

const consoleLog = (
  localScope: StageContext,
  stageName: string,
  path: string[],
  key: string,
  value: unknown,
  reset?: boolean,
) => {
  if (reset) {
    localScope.setDebugInfo(key, value, path);
  } else {
    localScope.addDebugInfo(key, value, path);
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
  localScope.addErrorInfo(key, value, path);
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
