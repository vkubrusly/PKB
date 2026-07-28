-- =============================================================================
-- storage_policies.sql — políticas do bucket "plantas" (upload de plantas p/ IA).
--
-- Rode UMA VEZ no Supabase → SQL Editor (depois de criar o bucket "plantas").
-- Sem isto, o upload de plantas no "Take-off por IA" retorna 403.
--
-- Regra: um membro da org pode subir/ler arquivos dentro da pasta da PRÓPRIA org
-- (o app grava em  <org_id>/<arquivo>).  Idempotente.
-- =============================================================================

drop policy if exists "plantas_org_upload" on storage.objects;
create policy "plantas_org_upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'plantas'
    and is_org_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "plantas_org_read" on storage.objects;
create policy "plantas_org_read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'plantas'
    and is_org_member(((storage.foldername(name))[1])::uuid)
  );
