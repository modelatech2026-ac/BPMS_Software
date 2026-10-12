-- ============================================================================
-- ProductionPulse BPMS - Database Seed Script
-- Target: Clean Slate with Single Pre-Seeded Super Admin
-- ============================================================================

-- Clean purge of all existing records
BEGIN;

TRUNCATE TABLE audit_logs CASCADE;
TRUNCATE TABLE time_logs CASCADE;
TRUNCATE TABLE tasks CASCADE;
TRUNCATE TABLE project_memberships CASCADE;
TRUNCATE TABLE projects CASCADE;
TRUNCATE TABLE access_requests CASCADE;
DELETE FROM users WHERE email != 'modelatech2026@gmail.com';

-- Pre-seed Super Admin
INSERT INTO users (
    id,
    full_name,
    email,
    role,
    primary_discipline,
    weekly_capacity_hrs,
    availability_status
) VALUES (
    'a0000000-0000-0000-0000-000000000001'::uuid,
    'Modelatech Super Admin',
    'modelatech2026@gmail.com',
    'SUPER_ADMIN',
    'AI & Automation',
    40,
    'ACTIVE'
) ON CONFLICT (email) DO UPDATE SET
    role = 'SUPER_ADMIN',
    availability_status = 'ACTIVE',
    updated_at = NOW();

COMMIT;
