# Retained values

This internal L4 capability chooses the value kept in a stage's read/write view.
`retainedForm` applies an already-decided verdict before summary or cloning;
`activeRule` preserves the no-policy/inert-policy shortcut. Neither function
tracks reads, changes live state, chooses a new redaction policy, or owns a frame.

`StageContext` calls it for each read and write it retains.
Adjacent tests cover whole/field redaction, summary/full retention, clone failure,
detachment, primitive fallback and the rule's single `isInert` observation.
