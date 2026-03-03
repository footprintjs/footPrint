/**
 * logger - Simple logging utility for the library
 *
 * WHY: Provides a consistent logging interface that can be easily
 * swapped out or configured in the future.
 *
 * DESIGN: Thin wrapper around console methods. Keeps the library
 * decoupled from specific logging implementations. Consumers can
 * bring their own logger (Winston, Pino, Bunyan, etc.) by passing
 * any object that satisfies the ILogger interface to
 * FlowChartBuilder.setLogger().
 */

/**
 * ILogger
 * ------------------------------------------------------------------
 * Minimal logging contract that any logger must satisfy.
 *
 * WHY: Enables consumers to inject their own logger (Winston, Pino,
 * Bunyan, console, or a custom implementation) without depending on
 * a specific logging library. The interface mirrors the standard
 * Console API subset so most loggers satisfy it out of the box.
 *
 * DESIGN: Only five methods — the universal set supported by every
 * major logging library. No levels, no transports, no formatting.
 * Those are the consumer's concern.
 */
export interface ILogger {
  info(message?: any, ...optionalParams: any[]): void;
  log(message?: any, ...optionalParams: any[]): void;
  debug(message?: any, ...optionalParams: any[]): void;
  error(message?: any, ...optionalParams: any[]): void;
  warn(message?: any, ...optionalParams: any[]): void;
}

/**
 * Default console-based logger.
 * Used as the fallback when no custom logger is provided.
 */
export const logger: ILogger = {
  info: (message?: any, ...optionalParams: any[]) => console.info(message, ...optionalParams),
  log: (message?: any, ...optionalParams: any[]) => console.log(message, ...optionalParams),
  debug: (message?: any, ...optionalParams: any[]) => console.debug(message, ...optionalParams),
  error: (message?: any, ...optionalParams: any[]) => console.error(message, ...optionalParams),
  warn: (message?: any, ...optionalParams: any[]) => console.warn(message, ...optionalParams),
};
