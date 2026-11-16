# Continue

Calls an injected local synthetic effect and then marks continuation. The effect port can stop its owned child process after appending a receipt, or throw a fixed synthetic error. Recovery can repeat the stage; the crash/replay integration case must visibly retain both effects for one task. No provider is called.
