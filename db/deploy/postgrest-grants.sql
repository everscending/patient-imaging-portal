-- Supabase may grant public-schema privileges directly to its API roles.
-- Anonymous callers get none; authenticated callers inherit only app_user.
revoke all on schema public from public;
revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;
revoke all on all functions in schema public from public;
revoke all on schema public from anon;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
revoke all on schema public from authenticated;
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;
revoke all on all functions in schema public from authenticated;
grant app_user to authenticated with inherit true, set false;
grant execute on function current_patient_id() to app_user;
grant execute on function current_provider_id() to app_user;
grant execute on function is_admin() to app_user;
