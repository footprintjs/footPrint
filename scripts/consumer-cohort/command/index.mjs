/** Preserve operational failures and subsequent guard failures as separate facts. */
function combined(primary, secondary) {
  return new AggregateError([primary, secondary], 'command and after-command guard both failed', { cause: primary });
}
function outcomeError(command, result) {
  return Object.assign(new Error('paired command failed: ' + command), { command, result });
}
/** Before refusal launches nothing; every attempted child receives its after guard, even on throw. */
export function guardedCommand(command, cwd, verify, run) {
  verify();
  let result;
  let failed = false;
  let primary;
  try {
    result = run(command, cwd);
  } catch (error) {
    failed = true;
    primary = error;
  }
  let guardFailed = false;
  let secondary;
  try {
    verify();
  } catch (error) {
    guardFailed = true;
    secondary = error;
  }
  if (failed) {
    if (guardFailed) throw combined(primary, secondary);
    throw primary;
  }
  const malformed =
    !result ||
    typeof result.ok !== 'boolean' ||
    result.ok !== (result.status === 0) ||
    !(result.status === null || Number.isSafeInteger(result.status)) ||
    result.skipped ||
    result.signal ||
    result.errorCode;
  if (malformed) {
    const error = outcomeError(command, result);
    if (guardFailed) throw combined(error, secondary);
    throw error;
  }
  if (guardFailed) {
    if (!result.ok || result.status !== 0) throw combined(outcomeError(command, result), secondary);
    throw secondary;
  }
  return result;
}
