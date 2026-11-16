'use strict';

exports.reply = (scope) => { scope.outcome = 'reply-recorded'; };
exports.timer = (scope) => { scope.outcome = 'waiting-ended'; };
