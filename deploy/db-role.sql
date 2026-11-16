-- Read-only role for the IPFS pinner. Run as a database admin.
-- Set the password out of band (for example with \password ipfs_pinner).
CREATE ROLE ipfs_pinner LOGIN CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE sourcify TO ipfs_pinner;
GRANT USAGE ON SCHEMA public TO ipfs_pinner;
GRANT SELECT ON public.sources, public.compiled_contracts_metadata TO ipfs_pinner;
ALTER ROLE ipfs_pinner SET statement_timeout = '60s';
ALTER ROLE ipfs_pinner SET default_transaction_read_only = on;
