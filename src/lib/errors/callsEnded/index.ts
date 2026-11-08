/** Why a call stopped when the stage attempt that made it ended without a reason of its own (it returned or threw). */
export function callsEndedReason(): Error {
  return new Error(
    '[footprint] $call: the stage attempt that made this call has ended — the call stops, and nothing it records ' +
      'lands on the stage. Await every call the stage makes.',
  );
}
