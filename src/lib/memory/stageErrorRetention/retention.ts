import type { StructuredErrorInfo } from '../../errors/errorInfo.js';
import { extractErrorInfo } from '../../errors/errorInfo.js';
import type { FailureReceipt, RetainedProjection } from '../../errors/failureRetention/index.js';

const decisions = new WeakMap<object, FailureReceipt['kind']>();
export function projectionKind(projection: object): FailureReceipt['kind'] {
  return decisions.get(projection) ?? 'unknown';
}
function decided(projection: RetainedProjection, kind: FailureReceipt['kind']) {
  decisions.set(projection, kind);
  return projection;
}

/** Diagnostic selection remains independent after consuming a child producer's projection. */
export function retainWrapper(projection: RetainedProjection, kept: unknown): RetainedProjection {
  if (kept === projection.message)
    return { message: projection.message, structuredError: { ...projection.structuredError } };
  const { name, code } = projection.structuredError;
  return {
    message: String(kept),
    structuredError: {
      message: String(kept),
      ...(name !== undefined && { name }),
      ...(code !== undefined && { code }),
      raw: undefined,
    },
  };
}

export function attemptError(info: StructuredErrorInfo) {
  return {
    message: info.message,
    ...(info.name !== undefined && { name: info.name }),
    ...(info.code !== undefined && { code: info.code }),
  };
}

interface Retention {
  readonly known?: StructuredErrorInfo;
  readonly active?: boolean;
  readonly selectedError: () => boolean;
  readonly selectedSources: () => boolean | 'unknown';
  readonly remember: (error: StructuredErrorInfo, strength: number) => void;
  readonly placeholder: string;
}

/** One projection at the producer; sample live sources after conversion and own-key reads. */
export function retainError(error: unknown, text: string, kept: unknown, rule: Retention) {
  let info: StructuredErrorInfo;
  let unreadable = false;
  try {
    info = rule.known ?? extractErrorInfo(error);
  } catch (failure) {
    if (!rule.active) throw failure;
    unreadable = true;
    info = { message: rule.placeholder, raw: undefined };
  }
  const selectedError = rule.known !== undefined || rule.selectedError();
  const source = rule.selectedSources();
  const selectedSources = source === true || source === 'unknown';
  const opaque =
    rule.active &&
    (unreadable ||
      typeof text !== 'string' ||
      typeof kept !== 'string' ||
      typeof info.message !== 'string' ||
      (info.name !== undefined && typeof info.name !== 'string'));
  if (rule.known && !selectedSources && !opaque)
    return decided({ message: rule.known.message, structuredError: { ...rule.known } }, 'masked');
  const textSelected = kept !== text;
  if (!selectedSources && !opaque && !selectedError && !textSelected)
    return decided({ message: text, structuredError: info }, 'clear');
  const message = selectedSources || opaque ? rule.placeholder : textSelected ? String(kept) : text;
  const masked: StructuredErrorInfo =
    selectedSources || opaque
      ? { message, raw: undefined }
      : {
          message: textSelected ? message : info.message,
          ...(info.name !== undefined && { name: info.name }),
          ...(info.code !== undefined && { code: info.code }),
          raw: undefined,
        };
  rule.remember(masked, selectedSources || opaque ? 2 : textSelected ? 1 : 0);
  return decided({ message, structuredError: masked }, source === 'unknown' ? 'unknown' : 'masked');
}
