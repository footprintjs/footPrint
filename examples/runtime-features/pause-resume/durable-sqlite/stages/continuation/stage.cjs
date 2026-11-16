'use strict';

module.exports = (effect) => (scope) => {
  effect({ kind: scope.winner, outcome: scope.outcome });
  scope.continued = true;
};
