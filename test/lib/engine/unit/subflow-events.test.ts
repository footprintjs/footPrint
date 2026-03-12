import { extractErrorInfo } from '../../../../src/lib/engine/errors/errorInfo';
import { ControlFlowNarrativeGenerator } from '../../../../src/lib/engine/narrative/ControlFlowNarrativeGenerator';
import { FlowRecorderDispatcher } from '../../../../src/lib/engine/narrative/FlowRecorderDispatcher';
import { NarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/NarrativeFlowRecorder';
import type { FlowSubflowEvent, FlowSubflowRegisteredEvent } from '../../../../src/lib/engine/narrative/types';

describe('Subflow event enrichment', () => {
  describe('FlowRecorderDispatcher', () => {
    it('onSubflowEntry passes subflowId and description to recorders', () => {
      const dispatcher = new FlowRecorderDispatcher();
      const events: FlowSubflowEvent[] = [];
      dispatcher.attach({ id: 'spy', onSubflowEntry: (e) => events.push(e) });

      dispatcher.onSubflowEntry('CreditCheck', 'sf-credit', 'Pull credit report');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        name: 'CreditCheck',
        subflowId: 'sf-credit',
        description: 'Pull credit report',
      });
    });

    it('onSubflowExit passes subflowId to recorders', () => {
      const dispatcher = new FlowRecorderDispatcher();
      const events: FlowSubflowEvent[] = [];
      dispatcher.attach({ id: 'spy', onSubflowExit: (e) => events.push(e) });

      dispatcher.onSubflowExit('CreditCheck', 'sf-credit');

      expect(events[0].subflowId).toBe('sf-credit');
    });

    it('onSubflowRegistered fans out to all recorders', () => {
      const dispatcher = new FlowRecorderDispatcher();
      const events: FlowSubflowRegisteredEvent[] = [];
      dispatcher.attach({ id: 'a', onSubflowRegistered: (e) => events.push(e) });
      dispatcher.attach({ id: 'b', onSubflowRegistered: (e) => events.push(e) });

      const spec = { name: 'DynFlow', type: 'stage' };
      dispatcher.onSubflowRegistered('dyn-1', 'DynFlow', 'Dynamic subflow', spec);

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        subflowId: 'dyn-1',
        name: 'DynFlow',
        description: 'Dynamic subflow',
        specStructure: spec,
      });
    });

    it('onSubflowRegistered is no-op with no recorders', () => {
      const dispatcher = new FlowRecorderDispatcher();
      expect(() => dispatcher.onSubflowRegistered('sf', 'name')).not.toThrow();
    });

    it('swallows errors in onSubflowRegistered', () => {
      const dispatcher = new FlowRecorderDispatcher();
      const calls: string[] = [];
      dispatcher.attach({
        id: 'bad',
        onSubflowRegistered: () => {
          throw new Error('boom');
        },
      });
      dispatcher.attach({
        id: 'good',
        onSubflowRegistered: (e) => calls.push(e.name),
      });

      dispatcher.onSubflowRegistered('sf', 'Flow');
      expect(calls).toEqual(['Flow']);
    });
  });

  describe('ControlFlowNarrativeGenerator', () => {
    it('includes description in subflow entry sentence', () => {
      const gen = new ControlFlowNarrativeGenerator();
      gen.onSubflowEntry('CreditCheck', 'sf-credit', 'Pull credit report');
      const sentences = gen.getSentences();
      expect(sentences[0]).toBe('Entering the CreditCheck subflow: Pull credit report.');
    });

    it('omits description when not provided', () => {
      const gen = new ControlFlowNarrativeGenerator();
      gen.onSubflowEntry('CreditCheck');
      expect(gen.getSentences()[0]).toBe('Entering the CreditCheck subflow.');
    });

    it('onSubflowRegistered produces no narrative output', () => {
      const gen = new ControlFlowNarrativeGenerator();
      gen.onSubflowRegistered('sf', 'name', 'desc');
      expect(gen.getSentences()).toEqual([]);
    });
  });

  describe('NarrativeFlowRecorder', () => {
    it('includes description in subflow entry sentence', () => {
      const recorder = new NarrativeFlowRecorder();
      recorder.onSubflowEntry({ name: 'CreditCheck', subflowId: 'sf-credit', description: 'Pull credit report' });
      expect(recorder.getSentences()[0]).toBe('Entering the CreditCheck subflow: Pull credit report.');
    });

    it('omits description when not provided', () => {
      const recorder = new NarrativeFlowRecorder();
      recorder.onSubflowEntry({ name: 'CreditCheck' });
      expect(recorder.getSentences()[0]).toBe('Entering the CreditCheck subflow.');
    });
  });
});
