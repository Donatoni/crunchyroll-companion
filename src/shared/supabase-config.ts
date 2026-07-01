/**
 * Supabase project config. Both values are safe to ship in the client: the anon
 * key is public by design and every table is guarded by row-level security that
 * confines each user to rows where `user_id = auth.uid()`.
 */
export const SUPABASE_URL = 'https://yoerrzzznpfcbsrrbocs.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvZXJyenp6bnBmY2JzcnJib2NzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NzA5NzIsImV4cCI6MjA5ODQ0Njk3Mn0.g02j-4idOqjGVJpjmwNO3SiUYctVYzxCuCFasquCR4Y';
