# Call lifetime refusal reason

This leaf creates the fixed error for a call whose owning stage attempt has ended. It imports no engine or attempt code and retains no call data. StageContext owns when the refusal is used; the helper only supplies the existing error.

Step 1 extraction: the function and comment move unchanged. Adjacent tests check a fresh Error per refusal and the fixed message. Remaining stage-state logic stays in StageContext.
