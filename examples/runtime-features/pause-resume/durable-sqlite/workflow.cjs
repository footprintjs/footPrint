'use strict';

const prepare = require('./stages/prepare/stage.cjs');
const wait = require('./stages/wait/stage.cjs');
const route = require('./stages/route/stage.cjs');
const result = require('./stages/result/stage.cjs');
const continuation = require('./stages/continuation/stage.cjs');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const core = (sdk, effect) => sdk.flowChart('Prepare operation', prepare, 'prepare')
  .setLogger(quiet)
  .addPausableFunction('Wait for host decision', wait, 'wait')
  .addDeciderFunction('Use recorded winner', route(sdk.decide), 'route')
    .addFunctionBranch('reply', 'Record reply outcome', result.reply)
    .addFunctionBranch('timer', 'Record timer outcome', result.timer)
    .end()
  .addFunction('Continue operation', continuation(effect), 'continue');

exports.terminal = (sdk, effect) => core(sdk, effect).build();
exports.repause = (sdk, effect) => core(sdk, effect)
  .addPausableFunction('Unsupported second wait', wait, 'second-wait')
  .build();
