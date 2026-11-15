import type { StructuredErrorInfo } from '../../errors/errorInfo.js';
import { extractErrorInfo } from '../../errors/errorInfo.js';

interface Retention {
  readonly selectedError: () => boolean;
  readonly selectedSources: () => boolean;
  readonly remember: (error: StructuredErrorInfo) => void;
  readonly placeholder: string;
}

/** One projection at the producer; sample live sources after conversion and own-key reads. */
export function retainError(error: unknown, text: string, kept: unknown, rule: Retention) {
  const info = extractErrorInfo(error);
  const selectedError = rule.selectedError();
  const selectedSources = rule.selectedSources();
  const textSelected = kept !== text;
  if (!selectedSources && !selectedError && !textSelected) return { message: text, structuredError: info };
  const message = selectedSources ? rule.placeholder : textSelected ? String(kept) : text;
  const masked: StructuredErrorInfo = selectedSources
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
