-- Earlier bindings copied the job audit string, which may be a retargetable alias.
-- Only a subsequent bridge started event can prove the execution's canonical cwd.
UPDATE agent_sessions SET workspace_path = NULL;
