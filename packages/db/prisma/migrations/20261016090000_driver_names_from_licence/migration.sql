-- Drivers who signed up with only an email or a username have no name on
-- their account, so riders saw "Driver" and the admin "Unnamed driver". Where
-- such a driver has given the name on their licence, that becomes their name.
-- A name already on an account is left alone. No structure changes.
UPDATE "User" AS u
SET "name" = d."legalName"
FROM "Driver" AS d
WHERE d."userId" = u."id"
  AND (u."name" IS NULL OR btrim(u."name") = '')
  AND d."legalName" IS NOT NULL
  AND btrim(d."legalName") <> '';
