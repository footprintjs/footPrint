'use strict';

module.exports = (decide) => (scope) => decide(scope, [
  { when: { winner: { eq: 'reply' } }, then: 'reply', label: 'Host selected reply' },
], { branch: 'timer', label: 'Host selected timer' });
