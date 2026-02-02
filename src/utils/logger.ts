/**
 * logger - Simple logging utility for the library
 * 
 * WHY: Provides a consistent logging interface that can be easily
 * swapped out or configured in the future.
 * 
 * DESIGN: Thin wrapper around console methods. Keeps the library
 * decoupled from specific logging implementations.
 */

const info = (message?: any, ...optionalParams: any[]) => {
  console.info(message, ...optionalParams);
};

const log = (message?: any, ...optionalParams: any[]) => {
  console.log(message, ...optionalParams);
};

const debug = (message?: any, ...optionalParams: any[]) => {
  console.debug(message, ...optionalParams);
};

const error = (message?: any, ...optionalParams: any[]) => {
  console.error(message, ...optionalParams);
};

export const logger = {
  info,
  log,
  debug,
  error,
};
