# Frame call limits

The existing call-record and late-write constants, with their full comments, moved as whole units from `StageContext.ts`. The context keeps its original source export and behavior. No limit changed; this extraction keeps its oversized facade from growing while private ownership is registered. `index.test.mjs` checks the existing constant ceilings; the unchanged late-write/call behavior remains covered by the frame suite.
