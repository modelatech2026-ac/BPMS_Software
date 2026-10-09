-- PostgreSQL Schema for BPMS Phase 1 (Authentication & RBAC Gating)

CREATE TYPE user_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'PROJECT_MANAGER', 'EDITOR', 'VIEWER');

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    google_id VARCHAR(128) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    avatar TEXT,
    status user_status NOT NULL DEFAULT 'PENDING',
    role user_role NOT NULL DEFAULT 'VIEWER',
    organization VARCHAR(255),
    discipline VARCHAR(255),
    access_reason TEXT,
    rejection_reason TEXT,
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    action VARCHAR(64) NOT NULL,
    target_user_email VARCHAR(255) NOT NULL,
    target_user_name VARCHAR(255) NOT NULL,
    performed_by VARCHAR(255) NOT NULL,
    details TEXT NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_google_id ON users(google_id);
CREATE INDEX idx_audit_logs_timestamp ON admin_audit_logs(timestamp DESC);

-- Seed initial Developer Super Admin: sushoovan Das
INSERT INTO users (
    google_id, 
    email, 
    name, 
    avatar, 
    status, 
    role, 
    organization, 
    discipline
) VALUES (
    'google_super_admin_sushoovan',
    'sushoovandas@gmail.com',
    'sushoovan Das',
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250',
    'APPROVED',
    'SUPER_ADMIN',
    'BPMS Core Systems',
    'BIM - ACS'
) ON CONFLICT (email) DO UPDATE SET 
    role = 'SUPER_ADMIN', 
    status = 'APPROVED';
