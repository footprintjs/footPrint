import type { StructuredErrorInfo } from '../../errors/errorInfo.js';
import { extractErrorInfo } from '../../errors/errorInfo.js';

interface Retention {
  readonly known?: StructuredErrorInfo;
  readonly active?: boolean;
  readonly selectedError: () => boolean;
  readonly selectedSources: () => boolean;
  readonly remember: (error: StructuredErrorInfo) => void;
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
  const selectedSources = rule.selectedSources();
  const opaque =
    rule.active &&
    (unreadable ||
      typeof text !== 'string' ||
      typeof kept !== 'string' ||
      typeof info.message !== 'string' ||
      (info.name !== undefined && typeof info.name !== 'string'));
  if (rule.known && !selectedSources && !opaque)
    return { message: rule.known.message, structuredError: { ...rule.known } };
  const textSelected = kept !== text;
  if (!selectedSources && !opaque && !selectedError && !textSelected) return { message: text, structuredError: info };
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
  rule.remember(masked);
  return { message, structuredError: masked };
}
