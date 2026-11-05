# readTiers candidate analysis

A pure, closed oracle for the one historical readTiers scenario. It accepts actual serialized current run bytes and the existing attention projection as data, proves the eight exact named #124 path changes against the old pin, and constructs only a candidate readTiers hash slot. It never runs a scenario, installs a dependency or writes either pin.

The current record must contain the scenario-owned TypeError, undefined deleted-key read/write/state, its exact error attention and one deletion commit row. Every other old byte remains exact. The actual raw native failure-origin witness stays independent. The candidate bytes are the actual run text, not the constructed expected oracle.

Adjacent synthetic tests exercise only this finite data contract. Real capture remains a separate explicit hosted test using SCENARIOS.readTiers, pinnedText and the actual existing withoutAttention. A candidate is adopted only after both real runtimes agree and its full path report is read. Other pins, old corpus and generators remain unchanged.
