-- A report-detail read needs one patient reference, but granting providers
-- SELECT on patients would expose every patient column. Return only the
-- existing DTO fields after re-checking the caller's exact relationship.
create or replace function read_report_detail(p_report_id uuid)
returns table (
  id uuid,
  study_id uuid,
  study_description text,
  patient_ref text,
  findings text,
  impression text,
  signed_by_name text,
  signed_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    r.id,
    r.study_id,
    s.description,
    p.patient_ref,
    r.findings,
    r.impression,
    signer.full_name,
    r.signed_at
  from reports r
  join studies s on s.id = r.study_id
  join patients p on p.id = r.patient_id
  join visits v on v.id = s.visit_id
  left join providers signer on signer.id = r.signed_by
  where r.id = p_report_id
    and (
      (r.patient_id = current_patient_id() and r.status = 'signed')
      or v.provider_id = current_provider_id()
      or is_admin()
    )
$$;

revoke all on function read_report_detail(uuid) from public;
grant execute on function read_report_detail(uuid) to app_user;
