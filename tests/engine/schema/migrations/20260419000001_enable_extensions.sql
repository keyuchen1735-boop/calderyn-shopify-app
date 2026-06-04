-- supabase/migrations/20260419000001_enable_extensions.sql
create extension if not exists pgcrypto with schema public;
create extension if not exists "uuid-ossp" with schema public;
