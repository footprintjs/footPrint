'use strict';

function winnerKind(input) {
  if (!input || typeof input !== 'object' || !['reply', 'timer'].includes(input.kind)) {
    throw new Error('INVALID_STORED_WINNER');
  }
  return input.kind;
}

exports.execute = (scope) => ({ operationKey: scope.operationKey, expects: 'host-decision' });
exports.resume = (scope, input) => { scope.winner = winnerKind(input); };
