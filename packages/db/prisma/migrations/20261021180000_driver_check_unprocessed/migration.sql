-- Prembly checks saved as "not found" when Prembly had only said it could not
-- process them ("could not be processed at the moment"): they said nothing
-- about the driver. They become errors, so they are not shown as Not found,
-- not counted as spent, and not reused: the next check asks again.
UPDATE "DriverCheck"
SET "outcome" = 'error'
WHERE "source" = 'prembly'
  AND "outcome" = 'not_found'
  AND COALESCE("note", '') !~* '(not\s*found|no\s+(record|data|match|result)s?|does\s*n.t\s+exist|could\s*not\s+be\s+found|cannot\s+be\s+found|unable\s+to\s+find|invalid\s+(licen[cs]e|plate|vehicle|policy|number|nin|bvn|id)|not\s+a\s+valid)';
