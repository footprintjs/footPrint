# Mapped input ownership

Detaches cloneable mapped values before the subflow freezes its arguments.
Own getters are sampled once while the mapper view is open, preserving all
other descriptors, symbol keys, prototype and class-instance references.
These existing units moved intact from SubflowExecutor; traversal, mapping,
redaction and seed commits keep their original owners. Adjacent tests cover
caller ownership, getter timing and non-cloneable class identity.
