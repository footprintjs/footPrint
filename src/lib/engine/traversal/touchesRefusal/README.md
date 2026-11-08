# Dynamic touching-node refusal wording

This internal helper adapts the shared touchesProblem verdict to the runtime node's stage name. It does not evaluate a key rule, execute a stage or introduce another side-effect policy. The traverser still decides when to ask it.

Step 1 extraction: its complete body and comment move unchanged. Adjacent tests cover admitted and refused declarations, retaining the existing verdict. Remaining traversal and dynamic-node admission stay with FlowchartTraverser.
