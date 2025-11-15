-- Migration script to fix ip_version constraint to be case-insensitive
-- This allows both 'ipv4'/'ipv6' and 'IPv4'/'IPv6' values

-- Step 1: Normalize existing values to lowercase
UPDATE servers 
SET ip_version = LOWER(ip_version) 
WHERE ip_version IS NOT NULL 
  AND ip_version != LOWER(ip_version);

-- Step 2: Drop existing constraint if it exists
ALTER TABLE servers 
DROP CONSTRAINT IF EXISTS servers_ip_version_check;

-- Step 3: Add case-insensitive constraint
ALTER TABLE servers 
ADD CONSTRAINT servers_ip_version_check 
CHECK (LOWER(ip_version) IN ('ipv4', 'ipv6') OR ip_version IS NULL);

-- Verify the constraint
SELECT 
    constraint_name, 
    check_clause 
FROM information_schema.check_constraints 
WHERE constraint_name = 'servers_ip_version_check';

